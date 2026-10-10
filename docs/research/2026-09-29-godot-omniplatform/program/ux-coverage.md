<!-- GENERATED from ux-coverage.json by the UX coverage pass. Edit ux-coverage.json (and re-run the generator), never this file. -->

# UX coverage: every proposed UX change, its owner, and what exists

The owner asked: _ensure we actually implement all the UX changes proposed, across SDKs and portals._ This file is the proof and the map. `ux-coverage.json` is the data; `node check.mjs --ux` prints live status from it; `node check.mjs` fails when a mockup screen has no owner. [`ux-waves.md`](ux-waves.md) schedules the work.

## 1. Totals

| What                                                                                   | Count    |
| -------------------------------------------------------------------------------------- | -------- |
| Mockup screens (brand/mockups, 11 areas)                                               | 173      |
| Hosted surfaces (sign-in cards, device and consent pages, emails)                      | 21       |
| Kit boards (frames in docs/design/ui-kits, every platform)                             | 115      |
| Kit frameworks (every UK package: platform, framework, tooling)                        | 64       |
| Design-doc sections (BRAND, UI-KITS, PORTAL, ADMIN, EXPERIENCE, SIGN-IN, SETUP, FLOWS) | 545      |
| Brand-transition rules (B1-B17 split into testable rules)                              | 147      |
| Owner rules (terse copy, responsive matrix, service accent, UX review, ...)            | 10       |
| Brand-transition changes (the 372 audit entries)                                       | 372      |
| **Items tracked**                                                                      | **1447** |

Of the 1447 items: 201 built in code today, 419 partial, 589 mockup-only (design exists, code does not), 238 informational or not a build item.

**Gaps.** The research flagged **80** items whose design had no owner, an owner that could not deliver it, or no UX gate; one more flag (UK-40, "desktop updater driver missing") was a false positive and was corrected after reading the code. Every one is now resolved: **7 new work packages** (ST-51, ST-52, LX-45, F-38, I-39, DOC-14, UK-63) and notes added to **174 existing briefs** (section "UX coverage (2026-10-09)" in each brief). The drift gate fails if any gap is left without a resolution.

## 2. How "done" is proven

1. **Owned.** Every mockup screen on disk has an entry here with at least one live owner (`node check.mjs` fails otherwise). Every other item has an owner or a written exemption.
2. **Gated.** Every screen, hosted surface and kit board has at least one owner whose brief carries the _Screen acceptance_ block and names `pkey-ux-reviewer` (BUILT mode), or all its owners are done.
3. **Delivered** = every owner (and cross-cutting overlay ST-48, ST-50, UK-58, UK-57) is `done`. **Reviewed** = delivered, and each owner that carries the gate has a passing review in [`ux-reviews.json`](ux-reviews.json).
4. **Recorded.** `node check.mjs --ux-review <ID> pass "<evidence>"` writes the ledger; `node check.mjs --set <ID> done` refuses a UX-gated package that owns screens until a pass exists (override: `--no-ux-gate`, with the reason in the PR). The lead should add the same check to `merge.sh`. Reviews done before the ledger existed (screenshots under `_mockups/review`) are not recorded; backfill with `--ux-review` where the evidence exists.

Today: **0 of 173 screens are delivered and UX-reviewed.** 93 screens are partial in code (an old-look page exists), 80 exist only as a mockup. Hosted surfaces: 9 built, 9 partial, 3 mockup-only (all in the pre-v2 look).

## 3. What is built today, and what only exists as a mockup

The honest list, from reading the code (2026-10-09), not the graph. "Brand v2" means the look of the brand transition (B1-B17).

**Brand v2 is built nowhere.** UK-58, UK-57, ST-48, ST-49, ST-50, PX-27..PX-33, UK-59, I-37 and I-38 are all `todo`.

- **Tokens (`packages/brand`):** surfaces, text, status, signed gold, motion, the eight service accents with the resolver and the Rubik/JetBrains Mono variable fonts, Pinned K and Star Cut marks, Delivery lockups, Powered-by badges, and generators for Swift, Godot, Python and the Node CLI. **Missing:** the `action-neutral` role, display scale and tracking, the B17 per-service ring/selected state tokens, the service icon set (`serviceIconSvg`, `ServiceIcon`), portrait cards, the trimmed header lockup, a hash manifest, the commerce accent.
- **Console (`packages/admin`):** a working console in the old look. Primary buttons take the section accent (`ui/Button.tsx`); 427 `font-bold` hits in 157 files; a 4 rem top bar and full-height sidebar; table rows 36/44 px. **Built and matching v2:** the 3 px nav marker with subtle fill (`Sidebar.tsx`), underline route tabs (`PageTabs.tsx`), `data-service` re-pointing the accent per section. **Missing:** inset canvas, condensed masthead, section bands, workbench tables, 56 px rows, reduced-transparency handling, recessed inputs, labelled scroll regions, per-row `data-service`.
- **Console screens that do not exist at all:** access and roles (Members, Roles, SSO rules, Invite, no-access, step-up), CLI login (`pkey login/whoami/logout`, `pkeyp_` tokens), Integration page, bulk keys, Cloud Sync pause/usage/product-role, entitlements (add-ons, catalog, renew, majors), connections (SSO), commerce (offers, purchases, sales; only the App Store product mapping page exists), release-track demote/promote and channels as a service, Platform Activity, the merged Platform Status.
- **Contradicted by built code:** config minted tokens live on a separate Edge mint page (`EdgeMintPage.tsx`, nav `edge-mint`); the mockups put recipe, key and approval on the catalog entry. U-31 now carries the removal.
- **Portal (`packages/admin/src/portal`):** sign-in card (methods, code, key, refused), Library, Discover, storefront, Activate, devices, Profile, sign-in methods with step-up, responsive e2e and axe tests. All pre-v2: accent primary, 40 px display type, sticky bordered header. **Missing:** Connected apps, Packages, Missing-a-license strip, decision panel, lapsed-page rules, account row in Activate, SHA-256 row, QR sign-in, device approval, email gate, consent UI.
- **Hosted pages (`packages/worker`):** device-code entry, device confirm ("Authorize X" with one button, no Deny: B9 is open), license choice, magic-link landing and refusals all exist as Worker HTML in the old look (accent button, danger-coloured alert, CSP `img-src` not widened). Emails: ~21 templates in the violet accent; HTML snapshots for 2 of them.
- **Terminal kits (UK-13 Python, UK-14 Node):** built, with goldens and pty tests for 24 of 27 frames. Gaps: Node boot, Python grouped help, shared `terminal-parity.json` is read by no test, no pipe/non-TTY frame on the board, Textual (UK-53) not started.
- **React (`packages/sdk-react`):** legacy components (LicenseGate, PolarisLogin, DeviceManager, UpdatePrompt, ConfigPanel) in a neutral theme. No `ui-core`, no `elements`, no `PolarisKeyGate`, no pixel baselines.
- **SwiftUI (`sdks/swift/PolarisKeyUI`):** gate, login, device-code and adaptive layouts in an iOS 17-era look; `Package.swift` declares only macOS 14 and iOS 17; settings exist only as strings; layout assertions but no image baselines.
- **Compose (`sdks/kotlin/ui`):** an Android-only library with 27 Roborazzi scenarios in the old look; no Credential Manager, predictive back or update bottom sheet; `desktop` is keyring/updater glue with no UI (the install driver lives in `:update`).
- **Godot (`sdks/godot/ui`):** gate, activation, sign-in, settings, boot, banner, offline and update prompt scenes; snapshots are 10 text tree dumps, no pixels; no sheet/glass host, no `process_mode`, the sign-in dialog still draws the QR on every device (B10 says TV/console only).
- **Qt (`sdks/python/.../ui/qt`):** `Theme.qml`, `qmldir` and generated QSS only; no screens. **No code at all for:** Web Components, Vue, Svelte, Angular, React Native, Electron/Tauri UI (bridge only), UIKit, AppKit, visionOS, tvOS, watchOS, WidgetKit, Android Views, Godot .NET beyond the generated brand file, native Windows, GNOME. Most of these are `deferred` by the owner (revive on an adopter), so their boards are tracked but not scheduled.
- **Enforcement:** the UK-55 design-language lint is optional and `todo` and targets kit boards; nothing runs the B6/B7/B17 rules, 400 % reflow, forced-colors or prefers-contrast over the built console or portal (new UK-63); the portal e2e checks 24 px targets, not 44; motion is the only owner rule fully enforced (tokens cap at 480 ms, reduced motion collapses to 0, motion e2e).
- **UX review itself** had no record: 160 briefs named `pkey-ux-reviewer`, but no file, gate or merge step said which package passed. `ux-reviews.json` and the `--set done` guard are new.

## 4. Gaps found and how each was resolved

| Item                                            | Gap                      | Resolution                                                                                                                                             | Resolved by         |
| ----------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `admin-3-05`                                    | no-owner                 | Add the console ConfirmDialog step-up state to the acceptance: caution row, 'Sign in again', the typed word kept across the round trip (plans/ST-28 s… | ST-30               |
| `admin-4-22`                                    | no-owner                 | Settle the spelling: mockups say 'Keys and secrets', nav.ts says 'Keys & secrets'; use 'and' (terse-copy rule).                                        | ST-45               |
| `brand-29`                                      | no-owner                 | Fix tools/services.json console.icon drift (config Settings2 -> SlidersHorizontal; distribution Truck -> the C4 choice).                               | UK-57               |
| `brand-30`                                      | no-owner                 | One line in packages/brand/scripts/gen.ts: the tokens.css header comment adds sync and commerce ids.                                                   | UK-58               |
| `brand-38`                                      | owner-wrong-scope        | ServiceGlyph (packages/admin/src/ui/ServiceBadge.tsx) renders @polaris-key/brand's service icons; UK-57 hands the swap to ST-48.                       | ST-48               |
| `overview-05`                                   | no-owner                 | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `overview-21`                                   | no-owner                 | Failed long-running tasks keep a durable home: an attention item on Home plus a record (EXPERIENCE 0.3 J-2).                                           | ST-44               |
| `sdk-a-09`                                      | owner-done-but-not-built | Remove welcome.lede and part.qr.scanInstead from kit-copy/en.json and the 8 locale packs, then regenerate kitCopy (UK-02a is done).                    | UK-59               |
| `sdk-c-14`                                      | owner-done-but-not-built | Replace the invented Godot status/error copy ('keep racing online...') with catalog copy and clear the strings.debt.json entries.                      | UK-11               |
| `site-13`                                       | no-owner                 | The long-operation readout (phase in words, percent in mono) lives in the shell feedback component; the first package with a long operation consumes…  | ST-48               |
| `B1.5`                                          | needs-ux-gate            | Add a test for the accent-distance floor 17.5 over the nine families to the acceptance.                                                                | UK-58               |
| `B10.3`                                         | needs-ux-gate            | B10: the toast keeps title-safe placement and the host-owns-pause rule (set process_mode so kit dialogs survive tree pause; verify in the engine); te… | UK-11, UK-50        |
| `B11.1`                                         | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B11.4`                                         | owner-wrong-scope        | Hand-off note: when U-05/U-20 ship, the website owner removes the 'In development' Cloud Sync label.                                                   | U-20                |
| `B11.5`                                         | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B13.1`                                         | needs-ux-gate            | Not mechanisable: enforced by the acceptance block's copy row plus the recorded pkey-ux-reviewer pass (ux-reviews.json).                               | UK-55, P0-36, ST-48 |
| `B14.1`                                         | owner-wrong-scope        | The Screen acceptance block was appended to the 12 selected packages that lacked it (UK-55 and SP-35b the full block, the rest an N/A line).           | UK-55               |
| `B14.6`                                         | needs-ux-gate            | Write the per-component 'must not' invariants (UI-KITS 4.1) as fixtures/lint rules.                                                                    | UK-02b, UK-55       |
| `B14.7`                                         | needs-ux-gate            | UK-41 requires an evidence ledger: a matrix cell is complete only with runtime evidence or a documented N/A.                                           | UK-41, UK-59        |
| `B15.1`                                         | no-owner                 | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B15.2`                                         | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B15.3`                                         | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B15.4`                                         | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B15.5`                                         | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B15.6`                                         | no-owner                 | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B17.7`                                         | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `B2.5`                                          | owner-wrong-scope        | Flip the shared ui/Button for the console AND the portal; PX-26..PX-32 must not reintroduce an accent primary.                                         | UK-58               |
| `B2.9`                                          | owner-wrong-scope        | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `B3.3`                                          | needs-ux-gate            | Assert that a selected nav item with a count badge keeps the badge's own status colour; the label drops font-bold (B7).                                | ST-48               |
| `B4.17`                                         | needs-ux-gate            | Assert that destructive and caution dialogs carry no accent top rule.                                                                                  | ST-48               |
| `B4.6`                                          | needs-ux-gate            | Add a masthead height probe (<=140/176 px) to layout.e2e (layoutProbe.ts).                                                                             | ST-48               |
| `B4.7`                                          | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `B5.3`                                          | owner-wrong-scope        | State that update and packs are removed from the console data-service set (marketing/docs only).                                                       | UK-57               |
| `B5.5`                                          | needs-ux-gate            | Add a nav test: every page id has an explicit data-service; none renders 'undefined'.                                                                  | ST-48               |
| `B6.1`                                          | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `B6.10`                                         | needs-ux-gate            | Assert full-bleed 16:9 art and no text drawn over customer art.                                                                                        | PX-30               |
| `B6.2`                                          | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `B6.3`                                          | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `B6.4`                                          | needs-ux-gate            | Add rules: hairline and sheet rim use the neutral border token; no eyebrow repeating the breadcrumb, no tagline (UK-63 runs them on console and porta… | UK-55               |
| `B6.6`                                          | needs-ux-gate            | Add rules: hairline and sheet rim use the neutral border token; no eyebrow repeating the breadcrumb, no tagline (UK-63 runs them on console and porta… | UK-55               |
| `B7.4`                                          | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `B9.3`                                          | needs-ux-gate            | Negative test: the device-code page cannot name the product before the code resolves.                                                                  | I-37                |
| `doc:BRAND#7.7-empty-states-and-illustration`   | no-owner                 | Acceptance line: every empty state uses the stationary-star motif (BRAND 7.7); EmptyState.tsx exists but nothing verified it.                          | ST-48, PX-26        |
| `doc:BRAND#v2-action-neutral-and-service-icons` | no-owner                 | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `doc:EXPERIENCE#J-1`                            | no-owner                 | Palette entity source, pasted-key resolution and GET /manage/api/search: new package ST-52.                                                            | ST-52               |
| `doc:EXPERIENCE#O8`                             | no-owner                 | Bulk Extend expiry, Change tier, Comp with preview, select-all-matching and a server job: new package LX-45.                                           | LX-45               |
| `doc:PORTAL#4.26`                               | owner-wrong-scope        | Acceptance carries the full B12 account nav (Profile, Sign-in methods, Connected apps, Packages, Where you're signed in, Appearance, Your data) and P… | PX-31               |
| `doc:PORTAL#5.3`                                | needs-ux-gate            | Carry the owner's 2026-10-08 lapsed-page decision: state once, no 'Not included' row, Renew only in the License card; DOC-14 amends PORTAL 5.3.        | PX-28               |
| `doc:PORTAL#6.1`                                | owner-done-but-not-built | P0-36 moves the portal to the copy catalog: it must delete the 'until UK-02a' inline copy in SignInPage.tsx and CodeCells.tsx and adopt the 6.1/6.2 r… | P0-36               |
| `doc:PORTAL#6.2`                                | owner-done-but-not-built | P0-36 moves the portal to the copy catalog: it must delete the 'until UK-02a' inline copy in SignInPage.tsx and CodeCells.tsx and adopt the 6.1/6.2 r… | P0-36               |
| `doc:SIGN-IN#6.6`                               | owner-dropped            | The doc amendments had no owner: new package DOC-14.                                                                                                   | DOC-14              |
| `hosted:email-shell`                            | no-owner                 | Emails on brand v2 and HTML snapshots: new package I-39.                                                                                               | I-39                |
| `hosted:email-snapshot-tests`                   | no-owner                 | Emails on brand v2 and HTML snapshots: new package I-39.                                                                                               | I-39                |
| `kitboard:godot.html:sign-in`                   | owner-wrong-scope        | B10: the Godot QR is for pad-only/console input only; drop it on desktop, tablet and phone; show the vanity URL.                                       | UK-11, UK-50        |
| `kitboard:godot.html:update-toast`              | owner-wrong-scope        | B10: the toast keeps title-safe placement and the host-owns-pause rule (set process_mode so kit dialogs survive tree pause; verify in the engine); te… | UK-11, UK-50        |
| `kitboard:terminal:pipe-quadrant`               | needs-ux-gate            | Draw a pipe/non-TTY quadrant on terminal.html (UK-59) and cover it in UK-51's contract rows.                                                           | UK-51, UK-59        |
| `kit:UK-22`                                     | owner-dropped            | UK-22 (host design systems) is dropped; UK-31's recipes cover 'your own design system'. Strike the UK-22 row in UI-KITS 10 (DOC-14).                   | UK-31               |
| `OR-a11y-acceptance-block`                      | needs-ux-gate            | The Screen acceptance block was appended to the 12 selected packages that lacked it (UK-55 and SP-35b the full block, the rest an N/A line).           | UK-55               |
| `OR-fullbleed-art`                              | needs-ux-gate            | Assert full-bleed 16:9 art and no text drawn over customer art.                                                                                        | PX-30               |
| `OR-kits-polaris-default`                       | needs-ux-gate            | A 'polaris-key / native' preset test per framework is a ui-matrix row in UK-02b; UK-22 is dropped, UK-31 recipes cover host design systems.            | UK-02b              |
| `OR-responsive-matrix`                          | needs-ux-gate            | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `OR-service-accent-states`                      | owner-wrong-scope        | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `OR-tablet-table-regions`                       | needs-ux-gate            | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `OR-terse-copy`                                 | needs-ux-gate            | Not mechanisable: enforced by the acceptance block's copy row plus the recorded pkey-ux-reviewer pass (ux-reviews.json).                               | UK-55, P0-36, ST-48 |
| `OR-touch-44`                                   | needs-ux-gate            | Console and portal were not covered by the UK-55 lint and e2e rows: new package UK-63.                                                                 | UK-63               |
| `admin.confirm-step-up`                         | owner-wrong-scope        | Add the console ConfirmDialog step-up state to the acceptance: caution row, 'Sign in again', the typed word kept across the round trip (plans/ST-28 s… | ST-30               |
| `admin.platform-activity`                       | owner-wrong-scope        | The standalone Platform Activity page and event drawer: new package ST-51.                                                                             | ST-51               |
| `admin.platform-activity-event`                 | owner-wrong-scope        | The standalone Platform Activity page and event drawer: new package ST-51.                                                                             | ST-51               |
| `config.approve-recipe-approved`                | owner-wrong-scope        | The recipe, key and approval live on the catalog entry; remove the Edge mint page (nav entry edge-mint, EdgeMintPage.tsx) and redirect its old URL to… | U-31                |
| `config.approve-recipe-open-access`             | needs-ux-gate            | Passkey step-up (I-30) on the approve drawer, with the failed state and Try again, named in the acceptance; add the widening warning, commit link and… | U-31                |
| `config.approve-recipe-passkey-failed`          | needs-ux-gate            | Passkey step-up (I-30) on the approve drawer, with the failed state and Try again, named in the acceptance; add the widening warning, commit link and… | U-31                |
| `config.catalog-invalid`                        | owner-wrong-scope        | C-24 in the mockup json is the console catalog page (not a work package): the review step, Copy the diff, the invalid state and per-entry changed-sin… | U-29, U-31          |
| `config.catalog-review`                         | owner-wrong-scope        | C-24 in the mockup json is the console catalog page (not a work package): the review step, Copy the diff, the invalid state and per-entry changed-sin… | U-29, U-31          |
| `config.entry-minted-token`                     | owner-wrong-scope        | The recipe, key and approval live on the catalog entry; remove the Edge mint page (nav entry edge-mint, EdgeMintPage.tsx) and redirect its old URL to… | U-31                |
| `config.entry-minted-token-no-key`              | owner-wrong-scope        | The recipe, key and approval live on the catalog entry; remove the Edge mint page (nav entry edge-mint, EdgeMintPage.tsx) and redirect its old URL to… | U-31                |
| `distribution.download-page`                    | needs-ux-gate            | The hosted dl.plrs.im download page uses its own renderer (worker page/render.ts), not the portal frame: restyle it to the focused task frame with th… | PX-29               |
| `licenses.change-tier`                          | owner-wrong-scope        | Add the Change tier dialog (licenses.change-tier) to the acceptance; it builds on LX-33's tier-change rules.                                           | LX-14               |
| `packages.cleanup-dry-run`                      | owner-wrong-scope        | The console cleanup dry-run dialog and the public-registry wizard: new package F-38 (F-36 and F-35 are Worker and CLI packages).                       | F-38                |
| `packages.public-registry`                      | owner-wrong-scope        | The console cleanup dry-run dialog and the public-registry wizard: new package F-38 (F-36 and F-35 are Worker and CLI packages).                       | F-38                |

Additional structural fixes made while merging: 30 screens had no owner that carries the UX gate (all their owners were Worker or CLI packages), so the Screen acceptance block was added to A-24, F-34, LX-36, LX-41, P0-29, P0-45, SP-32a, SP-33b and U-31; the 12 packages the overview-04 selector picks but whose briefs lacked the block (P0-33, SP-30, SP-35b, UK-55, DOC-04a/b, DOC-05a/b/c, DOC-07a, AX-03a, AX-15) now carry it (or an N/A line); `C-24` in two mockup files is a console page id, not a work package (replaced by U-29/U-31).

### New work packages

| Id                                                    | Title                                                                                                          | Lane    | Role        | Weeks   | Depends on                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- | ----------- | ------- | -------------------------- |
| [ST-51](wp/ST-51-platform-activity-page.md)           | Platform Activity page: Product facet, Timeline and Table, CSV export, Load more, event drawer                 | console | implementer | 0.5–0.8 | ST-45, ST-48               |
| [ST-52](wp/ST-52-palette-search.md)                   | Command palette search: entity results, pasted-key resolution and GET /manage/api/search                       | console | implementer | 1.0–1.5 | ST-44, ST-48               |
| [LX-45](wp/LX-45-bulk-licence-actions.md)             | Bulk licence actions: extend expiry, change tier, comp, select-all-matching, preview and a server job          | console | implementer | 1.0–1.5 | LX-14, LX-44, ST-29, ST-48 |
| [F-38](wp/F-38-feeds-console-cleanup-and-registry.md) | Package feeds console: the cleanup dry-run dialog and the public-registry wizard                               | console | implementer | 0.8–1.2 | F-35, F-36, ST-48          |
| [I-39](wp/I-39-emails-brand-v2.md)                    | Transactional emails on brand v2: ink action button, neutral callouts, lockup, HTML snapshots for every templ… | worker  | implementer | 0.6–1.0 | UK-58, I-38                |
| [DOC-14](wp/DOC-14-design-doc-amendments.md)          | Design-doc amendments: the B15 P0 fixes and the brand v2 text in BRAND, UI-KITS, EXPERIENCE, ADMIN, PORTAL an… | docs    | implementer | 0.5–0.8 | —                          |
| [UK-63](wp/UK-63-ux-bar-console-portal.md)            | UX bar for the built console and portal: B6, B7 and B17 lint over the rendered DOM, 400% reflow, forced-color… | ui      | implementer | 1.0–1.5 | ST-48, PX-26               |

## 5. Mockup screens (173)

### admin (13)

| Screen                          | Surface  | Owners                                                     | Brand v2 | In code     | Gap                         |
| ------------------------------- | -------- | ---------------------------------------------------------- | -------- | ----------- | --------------------------- |
| `admin.cli-login`               | terminal | ST-34, F-33, F-37, ST-30, I-19, UK-14 (done), UK-13 (done) | no       | mockup-only |                             |
| `admin.confirm-step-up`         | dialog   | I-30, ST-28 (done), ST-30; +ST-48                          | no       | mockup-only | resolved: owner-wrong-scope |
| `admin.invite`                  | dialog   | ST-31, ST-28 (done); +ST-48                                | no       | mockup-only |                             |
| `admin.members`                 | console  | ST-31, ST-29, ST-30, ST-32, ST-45; +ST-48, ST-50, UK-58    | no       | mockup-only |                             |
| `admin.no-access`               | console  | ST-29, ST-31, ST-45; +ST-48, ST-50, UK-58                  | no       | mockup-only |                             |
| `admin.no-access-home`          | console  | ST-29, ST-31, ST-30, ST-35; +ST-48, ST-50, UK-58           | no       | mockup-only |                             |
| `admin.platform-activity`       | console  | ST-45, ST-09, ST-51; +ST-48, ST-50, UK-58                  | no       | partial     | resolved: owner-wrong-scope |
| `admin.platform-activity-event` | dialog   | ST-45, ST-09, ST-51; +ST-48                                | no       | mockup-only | resolved: owner-wrong-scope |
| `admin.platform-settings`       | console  | ST-09, ST-11, ST-16, ST-27, I-31; +ST-48, ST-50, UK-58     | no       | partial     |                             |
| `admin.platform-status`         | console  | ST-09, ST-45; +ST-48, ST-50, UK-58                         | no       | partial     |                             |
| `admin.product-members`         | console  | ST-31, ST-08, ST-29, ST-45; +ST-48, ST-50, UK-58           | no       | mockup-only |                             |
| `admin.roles`                   | console  | ST-31, ST-28 (done), ST-35; +ST-48, ST-50, UK-58           | no       | mockup-only |                             |
| `admin.sso-rules`               | console  | ST-32, ST-28 (done), LX-36; +ST-48, ST-50, UK-58           | no       | mockup-only |                             |

### commerce (29)

| Screen                             | Surface | Owners                                                                 | Brand v2 | In code     | Gap |
| ---------------------------------- | ------- | ---------------------------------------------------------------------- | -------- | ----------- | --- |
| `commerce.add-to-offer`            | console | CM-23, CM-22, CM-20 (done), CM-29b; +ST-48, ST-50, UK-58               | no       | mockup-only |     |
| `commerce.connect-app-store`       | console | CM-29, CM-21, A-33, CM-29b; +ST-48, ST-50, UK-58                       | no       | partial     |     |
| `commerce.connect-app-store-error` | console | CM-29, CM-21, A-33, CM-29b; +ST-48, ST-50, UK-58                       | no       | partial     |     |
| `commerce.create-iap`              | console | CM-23, A-17g (done), CM-29b; +ST-48, ST-50, UK-58                      | no       | partial     |     |
| `commerce.features`                | console | CM-29, ST-38, CM-29b; +ST-48, ST-50, UK-58                             | no       | partial     |     |
| `commerce.features-blocked`        | console | CM-29, ST-38, CM-29b; +ST-48, ST-50, UK-58                             | no       | partial     |     |
| `commerce.features-save-failed`    | console | CM-29, ST-38, CM-29b; +ST-48, ST-50, UK-58                             | no       | partial     |     |
| `commerce.first-run`               | console | CM-29, CM-21, CM-23, A-33, A-21, CM-29b; +ST-48, ST-50, UK-58          | no       | partial     |     |
| `commerce.first-run-connected`     | console | CM-29, CM-21, CM-23, CM-29b; +ST-48, ST-50, UK-58                      | no       | mockup-only |     |
| `commerce.lists-states`            | dialog  | CM-23, ST-38, CM-29b; +ST-48, ST-50, UK-58                             | no       | mockup-only |     |
| `commerce.offer`                   | console | CM-23, CM-20 (done), LX-11, CM-29b; +ST-48, ST-50, UK-58               | no       | mockup-only |     |
| `commerce.offer-new`               | console | CM-23, CM-20 (done), LX-11, CM-29b; +ST-48, ST-50, UK-58               | no       | mockup-only |     |
| `commerce.offer-price`             | console | CM-23, CM-29b; +ST-48, ST-50, UK-58                                    | no       | partial     |     |
| `commerce.offer-price-failed`      | console | CM-23, CM-29b; +ST-48, ST-50, UK-58                                    | no       | partial     |     |
| `commerce.offer-price-invalid`     | console | CM-23, CM-29b; +ST-48, ST-50, UK-58                                    | no       | partial     |     |
| `commerce.offer-stop-selling`      | console | CM-23, A-17g (done), CM-29b; +ST-48, ST-50, UK-58                      | no       | partial     |     |
| `commerce.offers`                  | console | CM-23, CM-20 (done), LX-11, CM-25, CM-28, CM-29b; +ST-48, ST-50, UK-58 | no       | mockup-only |     |
| `commerce.offers-empty`            | console | CM-23, CM-29, CM-29b; +ST-48, ST-50, UK-58                             | no       | mockup-only |     |
| `commerce.offers-import`           | console | CM-23, CM-20 (done), CM-29b; +ST-48, ST-50, UK-58                      | no       | mockup-only |     |
| `commerce.purchase`                | console | CM-22, CM-23, CM-29b; +ST-48, ST-50, UK-58                             | no       | mockup-only |     |
| `commerce.purchase-renewal`        | dialog  | CM-23, LX-23, LX-41, CM-29b; +ST-48, ST-50, UK-58                      | no       | mockup-only |     |
| `commerce.purchases`               | console | CM-23, CM-22, CM-24, CM-25, LX-41, LX-23, CM-29b; +ST-48, ST-50, UK-58 | no       | mockup-only |     |
| `commerce.purchases-empty`         | console | CM-23, CM-29, CM-29b; +ST-48, ST-50, UK-58                             | no       | mockup-only |     |
| `commerce.purchases-no-results`    | console | CM-23, CM-22, CM-29b; +ST-48, ST-50, UK-58                             | no       | mockup-only |     |
| `commerce.restore`                 | dialog  | CM-23, UK-25, CM-29b; +ST-48, ST-50, UK-58                             | no       | mockup-only |     |
| `commerce.sales`                   | console | CM-23, A-22, CM-21, A-28, CM-22, CM-29b; +ST-48, ST-50, UK-58          | no       | mockup-only |     |
| `commerce.sales-wizard`            | console | CM-23, A-22, CM-21, A-18k (blocked), CM-29b; +ST-48, ST-50, UK-58      | no       | mockup-only |     |
| `commerce.storefronts`             | console | CM-23, A-21, A-22, CM-21, CM-29, CM-29b; +ST-48, ST-50, UK-58          | no       | partial     |     |
| `commerce.turn-off-licensing`      | console | ST-38, CM-29, CM-29b; +ST-48, ST-50, UK-58                             | no       | partial     |     |

### config (23)

| Screen                                 | Surface | Owners                                                                  | Brand v2 | In code     | Gap                         |
| -------------------------------------- | ------- | ----------------------------------------------------------------------- | -------- | ----------- | --------------------------- |
| `config.approve-recipe`                | dialog  | U-31; +ST-48                                                            | no       | partial     |                             |
| `config.approve-recipe-approved`       | console | U-31; +ST-48, ST-50, UK-58                                              | no       | partial     | resolved: owner-wrong-scope |
| `config.approve-recipe-open-access`    | dialog  | U-31; +ST-48                                                            | no       | partial     | resolved: needs-ux-gate     |
| `config.approve-recipe-passkey-failed` | dialog  | U-31; +ST-48                                                            | no       | mockup-only | resolved: needs-ux-gate     |
| `config.approve-recipe-stale`          | dialog  | U-31; +ST-48                                                            | no       | partial     |                             |
| `config.catalog-empty`                 | console | U-32, ST-42, ST-45; +ST-48, ST-50, UK-58                                | no       | mockup-only |                             |
| `config.catalog-invalid`               | console | U-29, U-31; +ST-48, ST-50, UK-58                                        | no       | partial     | resolved: owner-wrong-scope |
| `config.catalog-review`                | console | U-29, U-31; +ST-48, ST-50, UK-58                                        | no       | partial     | resolved: owner-wrong-scope |
| `config.catalog-review-states`         | dialog  | U-29, U-31; +ST-48                                                      | no       | partial     |                             |
| `config.cloud-sync`                    | console | U-32, U-01b, U-05, U-09, U-10, U-23, ST-16, ST-45; +ST-48, ST-50, UK-58 | no       | partial     |                             |
| `config.cloud-sync-paused`             | console | U-05, ST-16, U-32; +ST-48, ST-50, UK-58                                 | no       | mockup-only |                             |
| `config.cloud-sync-product-role`       | console | U-32, ST-16, ST-28 (done); +ST-48, ST-50, UK-58                         | no       | mockup-only |                             |
| `config.cloud-sync-usage`              | console | U-32, U-05; +ST-48, ST-50, UK-58                                        | no       | mockup-only |                             |
| `config.effective`                     | console | U-29, U-28, U-27, ST-45; +ST-48, ST-50, UK-58                           | no       | partial     |                             |
| `config.entry-draft-stale`             | console | U-31, U-29; +ST-48, ST-50, UK-58                                        | no       | partial     |                             |
| `config.entry-minted-token`            | console | U-31, U-30, ST-45; +ST-48, ST-50, UK-58                                 | no       | partial     | resolved: owner-wrong-scope |
| `config.entry-minted-token-no-key`     | console | U-31; +ST-48, ST-50, UK-58                                              | no       | mockup-only | resolved: owner-wrong-scope |
| `config.entry-setting`                 | console | U-30, U-29, U-01b, ST-45; +ST-48, ST-50, UK-58                          | no       | partial     |                             |
| `config.entry-setting-remove-value`    | console | U-30, U-29, ST-45; +ST-48, ST-50, UK-58                                 | no       | partial     |                             |
| `config.mint-wizard`                   | dialog  | U-32, U-31; +ST-48                                                      | no       | mockup-only |                             |
| `config.pause-writes`                  | dialog  | U-05, ST-16, U-32; +ST-48                                               | no       | mockup-only |                             |
| `config.profile`                       | console | U-28, U-29, ST-45; +ST-48, ST-50, UK-58                                 | no       | partial     |                             |
| `config.storage-default`               | dialog  | ST-16, U-05, U-01b; +ST-48                                              | no       | mockup-only |                             |

### distribution (8)

| Screen                               | Surface | Owners                                                         | Brand v2 | In code     | Gap                     |
| ------------------------------------ | ------- | -------------------------------------------------------------- | -------- | ----------- | ----------------------- |
| `distribution.channel-app-store`     | console | A-22, A-28, A-26, P2-08, CM-23; +ST-48, ST-50, UK-58           | no       | partial     |                         |
| `distribution.channel-setup`         | console | A-23, A-33, A-28, ST-39, A-18k (blocked); +ST-48, ST-50, UK-58 | no       | mockup-only |                         |
| `distribution.channels`              | console | A-19, A-20, A-21, A-33, A-28; +ST-48, ST-50, UK-58             | no       | mockup-only |                         |
| `distribution.channels-no-release`   | console | A-20, A-24, A-33; +ST-48, ST-50, UK-58                         | no       | mockup-only |                         |
| `distribution.channels-product-role` | console | A-20, A-24, ST-28 (done); +ST-48, ST-50, UK-58                 | no       | mockup-only |                         |
| `distribution.download-page`         | portal  | A-26, A-30, PX-09, A-20, P2-13, HA-09, PX-27, PX-29; +UK-58    | no       | partial     | resolved: needs-ux-gate |
| `distribution.publish`               | dialog  | A-24, P2-08, A-23; +ST-48                                      | no       | mockup-only |                         |
| `distribution.publish-result`        | dialog  | A-24, P2-08; +ST-48                                            | no       | mockup-only |                         |

### entitlements (12)

| Screen                              | Surface | Owners                                                  | Brand v2 | In code     | Gap |
| ----------------------------------- | ------- | ------------------------------------------------------- | -------- | ----------- | --- |
| `entitlements.addon`                | console | LX-35, LX-44, LX-25, LX-36, CM-23; +ST-48, ST-50, UK-58 | no       | mockup-only |     |
| `entitlements.addons`               | console | LX-35, LX-44, CM-23; +ST-48, ST-50, UK-58               | no       | mockup-only |     |
| `entitlements.catalog`              | console | LX-34, LX-44, LX-09; +ST-48, ST-50, UK-58               | no       | mockup-only |     |
| `entitlements.consumables`          | console | LX-42, LX-14, LX-09, LX-35, CM-28; +ST-48, ST-50, UK-58 | no       | partial     |     |
| `entitlements.duration`             | console | LX-41, LX-43, LX-44, LX-33; +ST-48, ST-50, UK-58        | no       | partial     |     |
| `entitlements.duration-trial`       | console | LX-41, LX-43, LX-44; +ST-48, ST-50, UK-58               | no       | partial     |     |
| `entitlements.duration-version`     | console | LX-41, LX-43, LX-44, LX-33; +ST-48, ST-50, UK-58        | no       | partial     |     |
| `entitlements.extend-major`         | dialog  | LX-43, LX-41; +ST-48                                    | no       | mockup-only |     |
| `entitlements.license-subscription` | console | LX-41, LX-14, LX-32, LX-40; +ST-48, ST-50, UK-58        | no       | partial     |     |
| `entitlements.new-major`            | console | LX-43, LX-41, LX-14, LX-23; +ST-48, ST-50, UK-58        | no       | partial     |     |
| `entitlements.renew`                | dialog  | LX-41; +ST-48                                           | no       | mockup-only |     |
| `entitlements.start-major`          | dialog  | LX-43, LX-44; +ST-48                                    | no       | mockup-only |     |

### identity (21)

| Screen                           | Surface | Owners                                                          | Brand v2 | In code     | Gap |
| -------------------------------- | ------- | --------------------------------------------------------------- | -------- | ----------- | --- |
| `identity.app-sign-in`           | console | I-29, I-32, I-34, I-35, I-14, I-33, ST-45; +ST-48, ST-50, UK-58 | no       | partial     |     |
| `identity.app-sign-in-changes`   | console | I-29, I-34, I-35; +ST-48, ST-50, UK-58                          | no       | partial     |     |
| `identity.connected-apps`        | portal  | I-34, I-11, PX-31                                               | no       | mockup-only |     |
| `identity.connection`            | console | I-30, I-31; +ST-48, ST-50, UK-58                                | no       | mockup-only |     |
| `identity.connection-audience`   | dialog  | I-30, I-31; +ST-48                                              | no       | mockup-only |     |
| `identity.connection-enforce`    | dialog  | I-30, I-29, I-31; +ST-48                                        | no       | mockup-only |     |
| `identity.connection-new`        | console | I-31, I-30, ST-39; +ST-48, ST-50, UK-58                         | no       | mockup-only |     |
| `identity.connection-new-failed` | console | I-31, I-30, ST-39; +ST-48, ST-50, UK-58                         | no       | mockup-only |     |
| `identity.connection-new-start`  | console | I-31, I-30, ST-39; +ST-48, ST-50, UK-58                         | no       | mockup-only |     |
| `identity.connections`           | console | I-31, I-30, I-32, P0-28, ST-45; +ST-48, ST-50, UK-58            | no       | mockup-only |     |
| `identity.consent`               | portal  | I-34, I-08, PX-14, I-37, I-38, P0-38                            | no       | mockup-only |     |
| `identity.device-code`           | portal  | PX-14, P0-38, I-37, I-38                                        | no       | partial     |     |
| `identity.device-code-states`    | dialog  | PX-14, P0-38, I-37, I-38                                        | no       | partial     |     |
| `identity.device-confirm`        | portal  | I-37, PX-14, P0-38, I-38                                        | no       | partial     |     |
| `identity.disconnect`            | dialog  | I-34, I-11; +ST-48                                              | no       | mockup-only |     |
| `identity.finish`                | portal  | I-33, PX-21, I-37, I-38, P0-38                                  | no       | mockup-only |     |
| `identity.key-step`              | portal  | PX-14, I-08, P0-38, I-37, I-38                                  | no       | partial     |     |
| `identity.refusals`              | dialog  | P0-38, PX-14, I-08, I-15, I-37, I-38                            | no       | partial     |     |
| `identity.sign-in`               | portal  | I-29, I-30, I-32, I-08, PX-14, I-37, I-38, P0-38                | no       | partial     |     |
| `identity.sign-in-off`           | dialog  | I-29, ST-38; +ST-48                                             | no       | partial     |     |
| `identity.sign-in-routes`        | dialog  | I-30, I-29, I-31, I-37, I-38, P0-38; +ST-48                     | no       | mockup-only |     |

### licenses (13)

| Screen                        | Surface | Owners                                                                       | Brand v2 | In code     | Gap                         |
| ----------------------------- | ------- | ---------------------------------------------------------------------------- | -------- | ----------- | --------------------------- |
| `licenses.access`             | console | P2-10, LX-36, LX-38, PS-12, F-34, P4-34; +ST-48, ST-50, UK-58                | no       | mockup-only |                             |
| `licenses.access-confirm`     | dialog  | P2-10, LX-36, PS-12; +ST-48                                                  | no       | mockup-only |                             |
| `licenses.access-rule`        | dialog  | LX-36, P2-10, LX-38; +ST-48                                                  | no       | mockup-only |                             |
| `licenses.access-rule-states` | dialog  | LX-36, P2-10; +ST-48                                                         | no       | mockup-only |                             |
| `licenses.bulk-keys`          | dialog  | LX-29, LX-27, LX-30 (done), LX-33; +ST-48                                    | no       | mockup-only |                             |
| `licenses.bulk-keys-done`     | dialog  | LX-29, LX-27, LX-30 (done); +ST-48                                           | no       | mockup-only |                             |
| `licenses.change-tier`        | dialog  | LX-32, LX-33, LX-38, LX-41, LX-14; +ST-48                                    | no       | mockup-only | resolved: owner-wrong-scope |
| `licenses.detail`             | console | LX-14, LX-32, LX-33, LX-35, LX-38, LX-41, LX-15; +ST-48, ST-50, UK-58        | no       | partial     |                             |
| `licenses.detail-holders`     | console | LX-30 (done), LX-14, LX-29, LX-38; +ST-48, ST-50, UK-58                      | no       | partial     |                             |
| `licenses.list`               | console | LX-30 (done), LX-13, LX-15, LX-38, LX-41, LX-29, P0-29; +ST-48, ST-50, UK-58 | no       | partial     |                             |
| `licenses.list-states`        | console | LX-30 (done), P0-29; +ST-48, ST-50, UK-58                                    | no       | partial     |                             |
| `licenses.tiers`              | console | LX-44, LX-33, LX-34, LX-41, LX-43; +ST-48, ST-50, UK-58                      | no       | partial     |                             |
| `licenses.tiers-states`       | console | LX-44, LX-41, LX-33, LX-43; +ST-48, ST-50, UK-58                             | no       | partial     |                             |

### packages (20)

| Screen                           | Surface  | Owners                                                          | Brand v2 | In code     | Gap                         |
| -------------------------------- | -------- | --------------------------------------------------------------- | -------- | ----------- | --------------------------- |
| `packages.cleanup-dry-run`       | dialog   | F-36, F-38; +ST-48, ST-50, UK-58                                | no       | partial     | resolved: owner-wrong-scope |
| `packages.demote`                | dialog   | P2-09, A-24; +ST-48, ST-50, UK-58                               | no       | mockup-only |                             |
| `packages.feeds`                 | console  | F-34, F-36, F-33, F-37, F-35, P2-10, A-21; +ST-48, ST-50, UK-58 | no       | partial     |                             |
| `packages.feeds-empty`           | console  | F-34; +ST-48, ST-50, UK-58                                      | no       | partial     |                             |
| `packages.feeds-install-refused` | console  | F-33, F-34, P2-10, LX-41; +ST-48, ST-50, UK-58                  | no       | mockup-only |                             |
| `packages.feeds-off`             | console  | F-34; +ST-48, ST-50, UK-58                                      | no       | partial     |                             |
| `packages.feeds-setup`           | terminal | F-37, F-33, ST-34                                               | no       | partial     |                             |
| `packages.feeds-turn-off`        | dialog   | F-34; +ST-48, ST-50, UK-58                                      | no       | partial     |                             |
| `packages.packs`                 | console  | P4-33, P4-34; +ST-48, ST-50, UK-58                              | no       | partial     |                             |
| `packages.portal-packages`       | portal   | F-33, F-37, F-34, F-35, PX-31; +UK-58                           | no       | partial     |                             |
| `packages.portal-token`          | dialog   | F-33; +ST-48, ST-50, UK-58                                      | no       | partial     |                             |
| `packages.portal-token-create`   | dialog   | F-33; +ST-48, ST-50, UK-58                                      | no       | mockup-only |                             |
| `packages.portal-token-revoke`   | dialog   | F-33; +ST-48, ST-50, UK-58                                      | no       | partial     |                             |
| `packages.promote`               | dialog   | P2-09, A-24, P2-08; +ST-48, ST-50, UK-58                        | no       | partial     |                             |
| `packages.public-registry`       | console  | F-35, F-34, F-38; +ST-48, ST-50, UK-58                          | no       | mockup-only | resolved: owner-wrong-scope |
| `packages.release-tracks`        | console  | P2-08, P2-09, A-24, F-36, LX-33; +ST-48, ST-50, UK-58           | no       | partial     |                             |
| `packages.release-tracks-stale`  | console  | P2-09, P2-08, A-24; +ST-48, ST-50, UK-58                        | no       | mockup-only |                             |
| `packages.updates`               | console  | P2-11, A-20, P2-08, P2-10, P2-12; +ST-48, ST-50, UK-58          | no       | partial     |                             |
| `packages.updates-failing`       | console  | P2-11, P2-12; +ST-48, ST-50, UK-58                              | no       | mockup-only |                             |
| `packages.updates-godot`         | console  | P2-11, A-20, P2-09, A-24, P2-10; +ST-48, ST-50, UK-58           | no       | mockup-only |                             |

### portal (13)

| Screen                    | Surface | Owners                                          | Brand v2 | In code | Gap |
| ------------------------- | ------- | ----------------------------------------------- | -------- | ------- | --- |
| `portal.account`          | portal  | PX-31, I-34, F-33, PX-W19                       | no       | partial |     |
| `portal.activate`         | dialog  | PX-29, LX-38, PX-W19                            | no       | partial |     |
| `portal.activate-confirm` | dialog  | PX-29, LX-38                                    | no       | partial |     |
| `portal.discover`         | portal  | LX-38, PS-12, P2-10, LX-36, P0-36               | no       | partial |     |
| `portal.discover-detail`  | portal  | PX-32, PS-05b, PS-12                            | no       | partial |     |
| `portal.download`         | portal  | PX-29, P2-13, LX-15                             | no       | partial |     |
| `portal.free-device`      | portal  | PX-29, LX-15, P0-36                             | no       | partial |     |
| `portal.library`          | portal  | LX-15, ST-36 (done), P0-36, LX-38, LX-39, LX-10 | no       | partial |     |
| `portal.library-12`       | portal  | PX-27, LX-15, P0-36                             | no       | partial |     |
| `portal.library-empty`    | portal  | PX-27, LX-38                                    | no       | partial |     |
| `portal.license`          | portal  | ST-36 (done), LX-41, LX-15, P0-36, LX-38, P2-13 | no       | partial |     |
| `portal.license-lapsed`   | portal  | LX-41, LX-15, P0-36                             | no       | partial |     |
| `portal.signin`           | portal  | PX-12, I-08, P0-38                              | no       | partial |     |

### products (12)

| Screen                           | Surface | Owners                                                                              | Brand v2 | In code     | Gap |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------- | -------- | ----------- | --- |
| `products.features`              | console | ST-38, CM-29, ST-08, PS-12, ST-14; +ST-48, ST-50, UK-58                             | no       | partial     |     |
| `products.home`                  | console | ST-44, ST-45; +ST-48, ST-50, UK-58                                                  | no       | partial     |     |
| `products.integration`           | console | ST-41, ST-40, SP-33a, SP-33b, LX-43, U-32, P2-11, I-36, ST-45; +ST-48, ST-50, UK-58 | no       | mockup-only |     |
| `products.new-product`           | console | ST-43, ST-42, ST-39; +ST-48, ST-50, UK-58                                           | no       | partial     |     |
| `products.overview`              | console | ST-41, ST-40, ST-44; +ST-48, ST-50, UK-58                                           | no       | partial     |     |
| `products.overview-a`            | console | ST-41, ST-40, ST-44; +ST-48, ST-50, UK-58                                           | no       | mockup-only |     |
| `products.overview-b`            | console | ST-41, ST-40, ST-44; +ST-48, ST-50, UK-58                                           | no       | mockup-only |     |
| `products.overview-c`            | console | ST-41, ST-40, ST-44; +ST-48, ST-50, UK-58                                           | no       | mockup-only |     |
| `products.settings-keys`         | console | ST-08, ST-34, ST-28 (done); +ST-48, ST-50, UK-58                                    | no       | partial     |     |
| `products.settings-presentation` | console | ST-08, HA-06 (done), I-29; +ST-48, ST-50, UK-58                                     | no       | partial     |     |
| `products.sidebar-contexts`      | console | ST-45, ST-29; +ST-48, ST-50, UK-58                                                  | no       | partial     |     |
| `products.turn-off-licensing`    | dialog  | ST-38, CM-29; +ST-48                                                                | no       | partial     |     |

### sdk (9)

| Screen                   | Surface  | Owners                            | Brand v2 | In code     | Gap |
| ------------------------ | -------- | --------------------------------- | -------- | ----------- | --- |
| `sdk.client-doctor`      | code     | SP-32a, SP-32b, SP-35             | no       | mockup-only |     |
| `sdk.docs-first-product` | code     | SP-37, SP-33b, SP-36              | no       | mockup-only |     |
| `sdk.pkey-doctor`        | terminal | P0-45, ST-40, SP-33a              | no       | partial     |     |
| `sdk.pkey-help`          | terminal | P0-45, SP-33a, UK-14 (done)       | no       | partial     |     |
| `sdk.react-activate`     | kit      | UK-03, UK-05, UK-06, UK-42        | no       | partial     |     |
| `sdk.react-sign-in`      | kit      | UK-03, UK-04, UK-05, UK-06, I-10a | no       | partial     |     |
| `sdk.start-call`         | code     | SP-32a, SP-32b, SP-35, SP-33b     | no       | mockup-only |     |
| `sdk.swiftui-activate`   | kit      | UK-07, UK-43, UK-02b              | no       | partial     |     |
| `sdk.swiftui-sign-in`    | kit      | UK-07, UK-02b, I-10b, HA-13       | no       | partial     |     |

## 6. Hosted surfaces (21)

| Surface                         | Owners                          | Brand v2 | In code     | Gap                |
| ------------------------------- | ------------------------------- | -------- | ----------- | ------------------ |
| `hosted:signin-card`            | PX-12, P0-38, PX-14, I-08       | no       | partial     |                    |
| `hosted:app-header-passport`    | PX-14, I-38, P0-38, PX-33       | no       | mockup-only |                    |
| `hosted:csp-img-src-branded`    | I-38                            | no       | mockup-only |                    |
| `hosted:device-code-entry`      | PX-14, P0-38, I-37              | no       | partial     |                    |
| `hosted:device-code-states`     | PX-14, P0-38                    | no       | partial     |                    |
| `hosted:device-confirm`         | I-37, PX-14, P0-38              | no       | partial     |                    |
| `hosted:consent`                | I-34, I-08, PX-14               | no       | mockup-only |                    |
| `hosted:license-choice`         | I-08, PX-14, P0-38              | no       | built       |                    |
| `hosted:key-on-ramp`            | PX-14, I-08, P0-38              | no       | partial     |                    |
| `hosted:refusals`               | P0-38, PX-14, I-08, I-15        | no       | partial     |                    |
| `hosted:finish-email-gate`      | I-33, PX-21, PX-12              | no       | partial     |                    |
| `hosted:magic-link-landing`     | PX-14, P0-38                    | no       | built       |                    |
| `hosted:brand-page-shell`       | P0-38, I-38                     | no       | built       |                    |
| `hosted:oauth-authorize-token`  | I-08, I-15                      | no       | partial     |                    |
| `hosted:email-shell`            | I-39                            | no       | built       | resolved: no-owner |
| `hosted:email-signin-code`      | PX-W7 (done), I-07 (done), I-39 | no       | built       |                    |
| `hosted:email-magic-link`       | PX-W7 (done), I-39              | no       | built       |                    |
| `hosted:email-notices-security` | PX-W7 (done), I-05 (done), I-39 | no       | built       |                    |
| `hosted:email-notices-license`  | PX-W7 (done), LX-10, I-39       | no       | built       |                    |
| `hosted:email-download-link`    | PX-W7 (done), P2-13, I-39       | no       | built       |                    |
| `hosted:email-snapshot-tests`   | I-39                            | no       | partial     | resolved: no-owner |

## 7. Kit boards by platform (115)

### Android (Compose) (11)

| Board                                   | Owners | In code     | Gap |
| --------------------------------------- | ------ | ----------- | --- |
| `kitboard:android.html:activate`        | UK-09  | partial     |     |
| `kitboard:android.html:device-limit`    | UK-09  | built       |     |
| `kitboard:android.html:font-200`        | UK-09  | built       |     |
| `kitboard:android.html:gate`            | UK-09  | built       |     |
| `kitboard:android.html:native-dynamic`  | UK-09  | partial     |     |
| `kitboard:android.html:predictive-back` | UK-09  | mockup-only |     |
| `kitboard:android.html:settings`        | UK-09  | built       |     |
| `kitboard:android.html:sign-in`         | UK-09  | mockup-only |     |
| `kitboard:android.html:states`          | UK-09  | built       |     |
| `kitboard:android.html:tablet`          | UK-09  | partial     |     |
| `kitboard:android.html:update-sheet`    | UK-09  | partial     |     |

### Android TV and Views (1)

| Board                                   | Owners       | In code | Gap |
| --------------------------------------- | ------------ | ------- | --- |
| `kitboard:android.html:sign-in-handoff` | UK-09, UK-35 | built   |     |

### Angular (1)

| Board                      | Owners       | In code     | Gap |
| -------------------------- | ------------ | ----------- | --- |
| `kitboard:web:angular-kit` | UK-19, UK-31 | mockup-only |     |

### Godot (11)

| Board                                | Owners       | In code     | Gap                         |
| ------------------------------------ | ------------ | ----------- | --------------------------- |
| `kitboard:godot.html:activate`       | UK-11        | partial     |                             |
| `kitboard:godot.html:boot`           | UK-11        | partial     |                             |
| `kitboard:godot.html:deck`           | UK-11        | mockup-only |                             |
| `kitboard:godot.html:device-limit`   | UK-11        | partial     |                             |
| `kitboard:godot.html:error`          | UK-11        | built       |                             |
| `kitboard:godot.html:gate`           | UK-11, UK-50 | partial     |                             |
| `kitboard:godot.html:settings`       | UK-11        | built       |                             |
| `kitboard:godot.html:sign-in`        | UK-11, UK-50 | partial     | resolved: owner-wrong-scope |
| `kitboard:godot.html:status`         | UK-11        | partial     |                             |
| `kitboard:godot.html:update-results` | UK-11        | mockup-only |                             |
| `kitboard:godot.html:update-toast`   | UK-11, UK-50 | mockup-only | resolved: owner-wrong-scope |

### Linux and GNOME (3)

| Board                               | Owners | In code     | Gap |
| ----------------------------------- | ------ | ----------- | --- |
| `kitboard:linux:activate-adwdialog` | UK-61  | mockup-only |     |
| `kitboard:linux:boot-status-error`  | UK-61  | mockup-only |     |
| `kitboard:linux:gate`               | UK-61  | mockup-only |     |

### Node and Python terminal (shared frames) (2)

| Board                             | Owners                                    | In code | Gap                     |
| --------------------------------- | ----------------------------------------- | ------- | ----------------------- |
| `kitboard:terminal:parity-json`   | UK-51, UK-02b, UK-14 (done), UK-13 (done) | partial |                         |
| `kitboard:terminal:pipe-quadrant` | UK-51, UK-46, UK-48, UK-59                | partial | resolved: needs-ux-gate |

### Node terminal (13)

| Board                                      | Owners                            | In code | Gap |
| ------------------------------------------ | --------------------------------- | ------- | --- |
| `kitboard:terminal:activate-masked-key`    | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:blocked-status`         | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:boot-healthy-offline`   | UK-14 (done), UK-45, UK-46, UK-51 | partial |     |
| `kitboard:terminal:cols-60`                | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:device-limit`           | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:ended-result-block`     | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:fallbacks`              | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:grouped-help`           | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:narrow-32x24`           | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:offline-request-120`    | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:short-40x12`            | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:sign-in-device-code`    | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |
| `kitboard:terminal:status-update-finished` | UK-14 (done), UK-45, UK-46, UK-51 | built   |     |

### Python Qt (4)

| Board                                   | Owners              | In code     | Gap |
| --------------------------------------- | ------------------- | ----------- | --- |
| `kitboard:qt:boot-status-error-windows` | UK-12               | mockup-only |     |
| `kitboard:qt:quick-activate-linux`      | UK-12               | mockup-only |     |
| `kitboard:qt:quick-gate-windows`        | UK-12, UK-13 (done) | mockup-only |     |
| `kitboard:qt:widgets-parts-qss`         | UK-12               | partial     |     |

### Python terminal (14)

| Board                                         | Owners                     | In code | Gap |
| --------------------------------------------- | -------------------------- | ------- | --- |
| `kitboard:terminal:activate-masked-key~py`    | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:blocked-status~py`         | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:boot-healthy-offline~py`   | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:cols-60~py`                | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:device-limit~py`           | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:ended-result-block~py`     | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:fallbacks~py`              | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:grouped-help~py`           | UK-13 (done), UK-48, UK-51 | partial |     |
| `kitboard:terminal:narrow-32x24~py`           | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:offline-request-120~py`    | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:short-40x12~py`            | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:sign-in-device-code~py`    | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:status-update-finished~py` | UK-13 (done), UK-48, UK-51 | built   |     |
| `kitboard:terminal:textual-app`               | UK-53, UK-13 (done)        | partial |     |

### React (23)

| Board                                   | Owners              | In code     | Gap |
| --------------------------------------- | ------------------- | ----------- | --- |
| `kitboard:web:activate-1440`            | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:components-boot`          | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:components-cloudsync`     | UK-05, UK-04, UK-47 | mockup-only |     |
| `kitboard:web:components-devices`       | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:components-grace-toasts`  | UK-05, UK-04, UK-47 | mockup-only |     |
| `kitboard:web:components-paywall`       | UK-05, UK-04, UK-47 | mockup-only |     |
| `kitboard:web:components-status-screen` | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:device-limit-1440`        | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:device-limit-390`         | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:forced-colors`            | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:gate-1440`                | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:gate-390`                 | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:layers-b-styled-parts`    | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:layers-c-headless`        | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:motion`                   | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:native-preset`            | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:settings-1440`            | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:settings-390`             | UK-05, UK-04, UK-47 | mockup-only |     |
| `kitboard:web:sign-in-1440`             | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:sign-in-390`              | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:states-sheet`             | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:theming-four-themes`      | UK-05, UK-04, UK-47 | partial     |     |
| `kitboard:web:update-prompt`            | UK-05, UK-04, UK-47 | partial     |     |

### Svelte (1)

| Board                     | Owners       | In code     | Gap |
| ------------------------- | ------------ | ----------- | --- |
| `kitboard:web:svelte-kit` | UK-18, UK-31 | mockup-only |     |

### SwiftUI and AppKit macOS (8)

| Board                                | Owners              | In code     | Gap |
| ------------------------------------ | ------------------- | ----------- | --- |
| `kitboard:desktop.html:activate`     | UK-08               | partial     |     |
| `kitboard:desktop.html:device-limit` | UK-08               | partial     |     |
| `kitboard:desktop.html:gate`         | UK-08, UK-24, UK-56 | partial     |     |
| `kitboard:desktop.html:macos15`      | UK-08               | partial     |     |
| `kitboard:desktop.html:settings`     | UK-08, UK-24        | mockup-only |     |
| `kitboard:desktop.html:sign-in`      | UK-08               | partial     |     |
| `kitboard:desktop.html:states`       | UK-08               | partial     |     |
| `kitboard:desktop.html:update`       | UK-08, UK-24        | mockup-only |     |

### SwiftUI iOS and iPadOS (13)

| Board                               | Owners              | In code     | Gap |
| ----------------------------------- | ------------------- | ----------- | --- |
| `kitboard:apple.html:ipad`          | UK-07, UK-56        | partial     |     |
| `kitboard:ios.html:activate`        | UK-07, UK-49        | partial     |     |
| `kitboard:ios.html:ax3`             | UK-07               | partial     |     |
| `kitboard:ios.html:device-limit`    | UK-07               | partial     |     |
| `kitboard:ios.html:gate`            | UK-07, UK-49, UK-56 | partial     |     |
| `kitboard:ios.html:ios18`           | UK-07               | partial     |     |
| `kitboard:ios.html:live-activity`   | UK-34               | mockup-only |     |
| `kitboard:ios.html:paywall`         | UK-25               | mockup-only |     |
| `kitboard:ios.html:settings`        | UK-07               | mockup-only |     |
| `kitboard:ios.html:sign-in`         | UK-07               | partial     |     |
| `kitboard:ios.html:states`          | UK-07               | partial     |     |
| `kitboard:ios.html:update`          | UK-07               | mockup-only |     |
| `kitboard:ios.html:update-required` | UK-07               | mockup-only |     |

### Vue (1)

| Board                  | Owners       | In code     | Gap |
| ---------------------- | ------------ | ----------- | --- |
| `kitboard:web:vue-kit` | UK-17, UK-31 | mockup-only |     |

### Web Components (1)

| Board                                  | Owners       | In code     | Gap |
| -------------------------------------- | ------------ | ----------- | --- |
| `kitboard:web:web-components-elements` | UK-04, UK-03 | mockup-only |     |

### Windows (5)

| Board                            | Owners                            | In code     | Gap |
| -------------------------------- | --------------------------------- | ----------- | --- |
| `kitboard:windows.html:activate` | UK-06, UK-21, UK-10, UK-12, UK-56 | mockup-only |     |
| `kitboard:windows.html:gate`     | UK-06, UK-21, UK-10, UK-12, UK-56 | mockup-only |     |
| `kitboard:windows.html:settings` | UK-06, UK-21, UK-10, UK-12, UK-56 | mockup-only |     |
| `kitboard:windows.html:states`   | UK-06, UK-21, UK-10, UK-12, UK-56 | mockup-only |     |
| `kitboard:windows.html:update`   | UK-06, UK-21, UK-10, UK-12, UK-56 | mockup-only |     |

### tvOS (1)

| Board                      | Owners       | In code | Gap |
| -------------------------- | ------------ | ------- | --- |
| `kitboard:apple.html:tvos` | UK-27, UK-56 | partial |     |

### visionOS (1)

| Board                          | Owners       | In code     | Gap |
| ------------------------------ | ------------ | ----------- | --- |
| `kitboard:apple.html:visionos` | UK-26, UK-56 | mockup-only |     |

### watchOS (1)

| Board                         | Owners       | In code     | Gap |
| ----------------------------- | ------------ | ----------- | --- |
| `kitboard:apple.html:watchos` | UK-33, UK-56 | mockup-only |     |

## 8. Kit frameworks (64)

| Kit                                                                 | Platform                              | Owners                                                                                                         | In code     | Note                                                                   |
| ------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `kit:UK-09` Compose Multiplatform: Android                          | Android (Compose)                     | UK-09, UK-01 (done), UK-02b                                                                                    | partial     |                                                                        |
| `kit:UK-28` Android Views interop                                   | Android TV and Views                  | UK-28, UK-09                                                                                                   | mockup-only |                                                                        |
| `kit:UK-35` Android TV, Glance, notifications                       | Android TV and Views                  | UK-35, UK-09                                                                                                   | partial     |                                                                        |
| `kit:UK-19` Angular                                                 | Angular                               | UK-19, UK-03, UK-04                                                                                            | mockup-only |                                                                        |
| `kit:UK-01` Brand tokens (Rubik, kit.ts, deriveAccent)              | Cross-kit (tokens, ui-core, QA, docs) | UK-01 (done)                                                                                                   | built       |                                                                        |
| `kit:UK-02` UI copy catalog plan                                    | Cross-kit (tokens, ui-core, QA, docs) | UK-02 (done)                                                                                                   | built       |                                                                        |
| `kit:UK-02a` Kit copy catalog and locale packs                      | Cross-kit (tokens, ui-core, QA, docs) | UK-02a (done), UK-02 (done)                                                                                    | built       |                                                                        |
| `kit:UK-02b` UI state fixtures and ui.\* parity rows                | Cross-kit (tokens, ui-core, QA, docs) | UK-02b, UK-02 (done), UK-02a (done)                                                                            | mockup-only |                                                                        |
| `kit:UK-03` ui-core (headless JS layer)                             | Cross-kit (tokens, ui-core, QA, docs) | UK-03, UK-01 (done), UK-14 (done)                                                                              | partial     |                                                                        |
| `kit:UK-04` Web Components (Lit) @polaris-key/elements              | Cross-kit (tokens, ui-core, QA, docs) | UK-04, UK-03, UK-01 (done)                                                                                     | mockup-only |                                                                        |
| `kit:UK-05` React (@polaris-key/react rebuild)                      | Cross-kit (tokens, ui-core, QA, docs) | UK-05, UK-03, UK-01 (done), UK-47                                                                              | partial     |                                                                        |
| `kit:UK-15` Visual QA harness and modernity lint                    | Cross-kit (tokens, ui-core, QA, docs) | UK-15 (done), UK-01 (done)                                                                                     | built       |                                                                        |
| `kit:UK-16` UI docs scaffold                                        | Cross-kit (tokens, ui-core, QA, docs) | UK-16 (done), UK-01 (done), UK-15 (done)                                                                       | built       |                                                                        |
| `kit:UK-22` Host design systems (Tailwind, shadcn, MUI)             | Cross-kit (tokens, ui-core, QA, docs) | UK-22 (dropped), UK-05, UK-31                                                                                  | mockup-only | UK-22 (host design systems) is dropped; UK-31's recipes cover 'your o… |
| `kit:UK-31` UI-kit recipes (Solid, Preact, htmx, Tauri, own design… | Cross-kit (tokens, ui-core, QA, docs) | UK-31, UK-04                                                                                                   | partial     |                                                                        |
| `kit:UK-41` Must-tier close-out                                     | Cross-kit (tokens, ui-core, QA, docs) | UK-41, UK-04, UK-05, UK-06, UK-07, UK-08, UK-09, UK-10, UK-11, UK-12, UK-13 (done), UK-14 (done), UK-16 (done) | mockup-only |                                                                        |
| `kit:UK-42` Activation without an account: ui-core, elements, React | Cross-kit (tokens, ui-core, QA, docs) | UK-42, UK-03, UK-05                                                                                            | mockup-only |                                                                        |
| `kit:UK-43` Activation without an account: native kits              | Cross-kit (tokens, ui-core, QA, docs) | UK-43, UK-42, UK-07, UK-09, UK-11, UK-12                                                                       | mockup-only |                                                                        |
| `kit:UK-44` SDK sign-in hints (dropped)                             | Cross-kit (tokens, ui-core, QA, docs) | UK-44 (dropped)                                                                                                | n/a         | dropped by the owner: UK-44                                            |
| `kit:UK-51` Terminal drop-in contract (cli family, exit 4)          | Cross-kit (tokens, ui-core, QA, docs) | UK-51, UK-02b                                                                                                  | mockup-only |                                                                        |
| `kit:UK-55` Design-language lint                                    | Cross-kit (tokens, ui-core, QA, docs) | UK-55, UK-15 (done)                                                                                            | partial     |                                                                        |
| `kit:UK-56` Kit mockups refresh for platforms with no built kit     | Cross-kit (tokens, ui-core, QA, docs) | UK-56                                                                                                          | partial     |                                                                        |
| `kit:UK-57` Brand assets (service icons, Delivery marks)            | Cross-kit (tokens, ui-core, QA, docs) | UK-57                                                                                                          | mockup-only |                                                                        |
| `kit:UK-58` Brand expression tokens (action-neutral, display scale) | Cross-kit (tokens, ui-core, QA, docs) | UK-58, UK-01 (done)                                                                                            | mockup-only |                                                                        |
| `kit:UK-59` Refresh built kits' boards from reviewed builds         | Cross-kit (tokens, ui-core, QA, docs) | UK-59, UK-47, UK-49, UK-50, UK-51, UK-56                                                                       | mockup-only |                                                                        |
| `kit:UK-06` Electron                                                | Electron and Tauri                    | UK-06, UK-03, UK-05                                                                                            | partial     |                                                                        |
| `kit:UK-21` Tauri v2                                                | Electron and Tauri                    | UK-21, UK-04, UK-06                                                                                            | mockup-only |                                                                        |
| `kit:UK-11` Godot Control nodes (GDScript)                          | Godot                                 | UK-11, UK-01 (done), UK-50                                                                                     | partial     |                                                                        |
| `kit:UK-29` Godot .NET (C#)                                         | Godot                                 | UK-29, UK-11                                                                                                   | partial     |                                                                        |
| `kit:UK-36` Godot editor dock restyle (dropped)                     | Godot                                 | UK-36 (parked), UK-11                                                                                          | partial     | dropped by the owner (optional); no action unless reinstated           |
| `kit:UK-37` Godot web-export overlay (dropped)                      | Godot                                 | UK-37 (parked)                                                                                                 | mockup-only | dropped by the owner (optional); no action unless reinstated           |
| `kit:UK-50` Godot drop-in fixes ahead of UK-11                      | Godot                                 | UK-50, UK-11                                                                                                   | mockup-only |                                                                        |
| `kit:UK-10` Compose Multiplatform: Desktop                          | JVM desktop                           | UK-10, UK-09, UK-40 (done), UK-56                                                                              | mockup-only |                                                                        |
| `kit:UK-40` Kotlin JVM desktop parity (keyring, updater driver)     | JVM desktop                           | UK-40 (done), UK-10                                                                                            | built       | The research agent reported the desktop updater driver missing; it li… |
| `kit:UK-54` JVM terminal kit (Mordant, Clikt, picocli)              | JVM terminal                          | UK-54, UK-51, UK-02b                                                                                           | mockup-only |                                                                        |
| `kit:UK-61` Native GNOME kit (PyGObject)                            | Linux and GNOME                       | UK-61, UK-12, UK-56                                                                                            | mockup-only |                                                                        |
| `kit:UK-14` Node terminal kit                                       | Node terminal                         | UK-14 (done), UK-01 (done), UK-15 (done)                                                                       | built       |                                                                        |
| `kit:UK-32` Ink components                                          | Node terminal                         | UK-32, UK-14 (done)                                                                                            | mockup-only |                                                                        |
| `kit:UK-45` Node terminal kit 0.8.x fixes                           | Node terminal                         | UK-45, UK-14 (done)                                                                                            | mockup-only |                                                                        |
| `kit:UK-46` Node terminal kit for existing CLIs (drop-in)           | Node terminal                         | UK-46, UK-14 (done), UK-51                                                                                     | partial     |                                                                        |
| `kit:UK-52` Node CLI frameworks: oclif plugin and Ink               | Node terminal                         | UK-52, UK-46, UK-51                                                                                            | mockup-only |                                                                        |
| `kit:UK-12` Qt (PySide6/PyQt6)                                      | Python Qt                             | UK-12, UK-01 (done), UK-13 (done), UK-56                                                                       | partial     |                                                                        |
| `kit:UK-30` Tkinter kit (dropped)                                   | Python other (Tk, wx, web)            | UK-30 (dropped)                                                                                                | n/a         | dropped by the owner: UK-30                                            |
| `kit:UK-38` wxPython and Kivy adapters                              | Python other (Tk, wx, web)            | UK-38, UK-12                                                                                                   | mockup-only |                                                                        |
| `kit:UK-39` Python web UIs (NiceGUI, Gradio, Flet)                  | Python other (Tk, wx, web)            | UK-39, UK-12, UK-04                                                                                            | mockup-only |                                                                        |
| `kit:UK-13` Python terminal kit                                     | Python terminal                       | UK-13 (done), UK-01 (done), UK-15 (done)                                                                       | built       |                                                                        |
| `kit:UK-48` Python terminal kit as mountable drop-in                | Python terminal                       | UK-48, UK-13 (done), UK-51                                                                                     | partial     |                                                                        |
| `kit:UK-53` Textual screens for host apps                           | Python terminal                       | UK-53, UK-48, UK-51                                                                                            | partial     |                                                                        |
| `kit:UK-47` React kit and gate fixes before UK-05                   | React                                 | UK-47, UK-05                                                                                                   | mockup-only |                                                                        |
| `kit:UK-62` Kit playground                                          | React                                 | UK-62, UK-47                                                                                                   | mockup-only |                                                                        |
| `kit:UK-20` React Native / Expo                                     | React Native                          | UK-20, UK-03, UK-05, UK-07, UK-09                                                                              | mockup-only |                                                                        |
| `kit:UK-18` Svelte 5 / SvelteKit                                    | Svelte                                | UK-18, UK-03, UK-04                                                                                            | mockup-only |                                                                        |
| `kit:UK-08` SwiftUI macOS 26                                        | SwiftUI and AppKit macOS              | UK-08, UK-07, UK-56                                                                                            | mockup-only |                                                                        |
| `kit:UK-24` AppKit                                                  | SwiftUI and AppKit macOS              | UK-24, UK-08, UK-56                                                                                            | mockup-only |                                                                        |
| `kit:UK-07` SwiftUI iOS / iPadOS 26                                 | SwiftUI iOS and iPadOS                | UK-07, UK-01 (done), UK-02b                                                                                    | partial     |                                                                        |
| `kit:UK-25` StoreKit 2 paywall                                      | SwiftUI iOS and iPadOS                | UK-25, UK-07                                                                                                   | mockup-only |                                                                        |
| `kit:UK-49` SwiftUI kit and Swift SDK 0.8.x correctness pass        | SwiftUI iOS and iPadOS                | UK-49, UK-07                                                                                                   | partial     |                                                                        |
| `kit:UK-23` UIKit (+ Mac Catalyst)                                  | UIKit and widgets                     | UK-23, UK-07                                                                                                   | mockup-only |                                                                        |
| `kit:UK-34` WidgetKit, Live Activities, App Intents                 | UIKit and widgets                     | UK-34, UK-07                                                                                                   | mockup-only |                                                                        |
| `kit:UK-17` Vue 3 / Nuxt                                            | Vue                                   | UK-17, UK-03, UK-04                                                                                            | mockup-only |                                                                        |
| `kit:UK-60` Native Windows kit (WinUI 3 / WPF)                      | Windows                               | UK-60, UK-02b, UK-56                                                                                           | mockup-only |                                                                        |
| `kit:UK-27` tvOS                                                    | tvOS                                  | UK-27, UK-07, UK-56                                                                                            | mockup-only |                                                                        |
| `kit:UK-26` visionOS                                                | visionOS                              | UK-26, UK-07, UK-56                                                                                            | mockup-only |                                                                        |
| `kit:UK-33` watchOS                                                 | watchOS                               | UK-33, UK-07, UK-56                                                                                            | mockup-only |                                                                        |

## 9. Brand-transition rules and owner rules (157)

| Rule                                                                                                 | Owners                                                                | In code     | Note                                                                             |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `B1.1` Commerce accent is the Distribution green family (colour only)                                | CM-29b                                                                | mockup-only |                                                                                  |
| `B1.2` No ninth vermilion accent family                                                              | CM-29b, UK-58                                                         | mockup-only |                                                                                  |
| `B1.3` The commerce service slug and routes (CM-29) stay; only colour changes                        | CM-29                                                                 | mockup-only |                                                                                  |
| `B1.4` Commerce chrome = Distribution colours + shopping-bag glyph + Pinned K mar…                   | CM-29b, UK-57                                                         | mockup-only |                                                                                  |
| `B1.5` Accent-distance floor stays 17.5 (not lowered)                                                | UK-58, CM-29b                                                         | mockup-only | Add a test for the accent-distance floor 17.5 over the nine families to the acc… |
| `B2.1` New token role action-neutral generated via pnpm gen brand                                    | UK-58                                                                 | mockup-only |                                                                                  |
| `B2.2` Dark: action #f6f8ff, label #060912                                                           | UK-58                                                                 | mockup-only |                                                                                  |
| `B2.3` Light: action #060912, label #ffffff                                                          | UK-58                                                                 | mockup-only |                                                                                  |
| `B2.4` Console primary button is neutral ink                                                         | ST-48, UK-58                                                          | mockup-only |                                                                                  |
| `B2.5` Portal primary button is neutral ink                                                          | UK-58, PX-30, PX-31                                                   | mockup-only | Flip the shared ui/Button for the console AND the portal; PX-26..PX-32 must not… |
| `B2.6` Hosted sign-in (Worker HTML) primary is neutral ink                                           | I-38, PX-12, P0-38                                                    | mockup-only |                                                                                  |
| `B2.7` Danger stays red; accent marks context only (nav marker, links, masthead t…                   | ST-48, UK-55                                                          | partial     |                                                                                  |
| `B2.8` UI kits keep host/product accent as primary (DL13); polaris-key preset pri…                   | UK-05, UK-04, UK-07, UK-09, UK-11                                     | partial     |                                                                                  |
| `B2.9` Amend BRAND §5.4, ADMIN §2.4, PORTAL §0.2/§0.3 for ink primary                                | UK-58, DOC-14                                                         | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B3.1` Selected nav item = subtle accent fill + 3 px solid inset marker                              | ST-45, ST-48                                                          | built       |                                                                                  |
| `B3.2` Not a solid accent pill                                                                       | ST-48                                                                 | built       |                                                                                  |
| `B3.3` Count badges keep their own status colour inside the selected item                            | ST-48                                                                 | partial     | Assert that a selected nav item with a count badge keeps the badge's own status… |
| `B3.4` Focus ring violet everywhere (fix ADMIN §2.4 inconsistency) - now supersed…                   | ST-48, UK-58                                                          | built       |                                                                                  |
| `B4.1` Inset canvas: raised, rounded ~18 px, 3 px accent top rule, from 1024 px;…                    | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.2` Condensed masthead: ONE orientation line (glyph chip + crumbs); no eyebrow…                   | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.3` Never "Platform" on a product page; no "WORKSPACE" label                                      | ST-48, ST-45                                                          | partial     |                                                                                  |
| `B4.4` h1 36/44 collections, 32/40 records, phone 24/32, long-name clamp                             | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.5` 48 px flat service tile only at >=1024 px on feature landing pages; produc…                   | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.6` Masthead height <=140 px (176 px max)                                                         | ST-48                                                                 | mockup-only | Add a masthead height probe (<=140/176 px) to layout.e2e (layoutProbe.ts).       |
| `B4.7` Section head bands 18/24 titles WITHOUT numerals (numbers only for ordered…                   | ST-48, UK-55, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `B4.8` Route tabs are an UNDERLINE tablist (not segmented); fade only when overfl…                   | ST-48                                                                 | partial     |                                                                                  |
| `B4.9` Workbench: ONE bordered band holds filters + table                                            | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.10` Table rows 56 px (never 76)                                                                  | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.11` Sentence-case table heads; solid-outline chips                                               | ST-48                                                                 | partial     |                                                                                  |
| `B4.12` Tablet: contained scroll in a labelled focusable region with sticky first…                   | ST-48, PX-26                                                          | partial     |                                                                                  |
| `B4.13` Neutral sidebar group labels with a 3 px accent bar                                          | ST-48, ST-45                                                          | mockup-only |                                                                                  |
| `B4.14` Recessed inputs (3:1 border check)                                                           | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.15` Dialogs/drawers: 3 px accent top rule + head band                                            | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.16` Dialogs: ONE leading glyph (severity for confirmations, subject mark for r…                  | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.17` No accent rule on destructive/caution dialogs                                                | ST-48                                                                 | mockup-only | Assert that destructive and caution dialogs carry no accent top rule.            |
| `B4.18` Blurred backdrop with reduced-transparency fallback                                          | ST-48                                                                 | mockup-only |                                                                                  |
| `B4.19` Bounded measure 72ch; Features table full width                                              | ST-48, ST-38                                                          | partial     |                                                                                  |
| `B4.20` Dashboard split (Needs attention 2/3 + Platform ready 1/3) at >=1280 only                    | ST-44, ST-48                                                          | mockup-only |                                                                                  |
| `B4.21` Product cover cards: 72 px ProductArt banner in Cards view only (hosted ar…                  | ST-48, ST-44                                                          | partial     |                                                                                  |
| `B5.1` Ship builds is one identity: Package glyph + Release cyan chrome (rule, ti…                   | ST-48, A-21, A-22                                                     | mockup-only |                                                                                  |
| `B5.2` Crumb "<Product> > Ship builds > ..."                                                         | ST-48, A-21                                                           | mockup-only |                                                                                  |
| `B5.3` Distribution green stays on Commerce/Sales surfaces; Update tangerine and…                    | CM-29b, UK-57                                                         | partial     | State that update and packs are removed from the console data-service set (mark… |
| `B5.4` Cloud Sync (one page) = one nav row                                                           | ST-45, U-32                                                           | mockup-only |                                                                                  |
| `B5.5` Non-protocol areas need explicit data-service mapping (never "undefined")                     | ST-48, UK-55                                                          | partial     | Add a nav test: every page id has an explicit data-service; none renders 'undef… |
| `B6.1` No glows                                                                                      | ST-48, UK-55, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `B6.2` No gradients / washes (product chrome)                                                        | ST-48, UK-55, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `B6.3` No coloured shadows                                                                           | ST-48, UK-55, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `B6.4` No accent-tinted card hairlines / sheet rims (also not under native/forced…                   | UK-55, ST-48                                                          | mockup-only | Add rules: hairline and sheet rim use the neutral border token; no eyebrow repe… |
| `B6.5` No section numerals                                                                           | ST-48, UK-55                                                          | partial     |                                                                                  |
| `B6.6` No marketing eyebrows/taglines/slogans in product chrome                                      | UK-55, ST-48                                                          | mockup-only | Add rules: hairline and sheet rim use the neutral border token; no eyebrow repe… |
| `B6.7` No display-size h1 in console                                                                 | ST-48                                                                 | built       |                                                                                  |
| `B6.8` No 76 px rows                                                                                 | ST-48                                                                 | built       |                                                                                  |
| `B6.9` No uppercase table heads / eyebrow transforms on identifiers                                  | ST-48, UK-55                                                          | partial     |                                                                                  |
| `B6.10` No name painted over art                                                                     | PX-30, UK-55                                                          | partial     | Assert full-bleed 16:9 art and no text drawn over customer art.                  |
| `B6.11` No floating header bar                                                                       | ST-48, PX-31                                                          | mockup-only |                                                                                  |
| `B6.12` No phone tabs in a second header row (portal keeps bottom bar)                               | PX-31, PX-27                                                          | built       |                                                                                  |
| `B6.13` No chartreuse fills in the core-violet portal                                                | PX-30, PX-31                                                          | partial     |                                                                                  |
| `B6.14` No tilted/parallax/looping motion                                                            | UK-55, MO-13                                                          | partial     |                                                                                  |
| `B6.15` No durations >480 ms                                                                         | UK-58, MO-13                                                          | built       |                                                                                  |
| `B6.16` No text <12 px                                                                               | UK-55                                                                 | partial     |                                                                                  |
| `B6.17` Signing/success not drawn in accent; gold = signing only; accent never = s…                  | UK-55                                                                 | mockup-only |                                                                                  |
| `B6.18` No forced dark theme                                                                         | ST-48, PX-26                                                          | built       |                                                                                  |
| `B6.19` No per-component focus colours                                                               | UK-55, UK-58                                                          | built       |                                                                                  |
| `B6.20` No accent edge on kit cards / terminal chrome (opt-in token only)                            | UK-55, UK-05                                                          | mockup-only |                                                                                  |
| `B7.1` Weights 400/500/600 on every surface; 700 only for the wordmark                               | UK-58, ST-50                                                          | partial     |                                                                                  |
| `B7.2` Console font-bold sweep (426 uses) to 500/600                                                 | ST-50                                                                 | mockup-only |                                                                                  |
| `B7.3` Display scale + display tracking tokens only >=40 px and at most -0.02em i…                   | UK-58                                                                 | mockup-only |                                                                                  |
| `B7.4` Lint that rejects 700 in console and portal                                                   | ST-50, UK-55, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `B8.1` Hosted card uses neutral ink primary                                                          | I-38, PX-12                                                           | mockup-only |                                                                                  |
| `B8.2` DL6 neutral callout for ALL refusals (device limit, all-full, email mismat…                   | PX-12, PX-15, I-38                                                    | mockup-only |                                                                                  |
| `B8.3` Fix is the one primary; NO disabled-primary dead end (amber only for "unsy…                   | PX-12, PX-15                                                          | mockup-only |                                                                                  |
| `B8.4` Passport = neutral SUNKEN identity pane in both themes                                        | I-38                                                                  | mockup-only |                                                                                  |
| `B8.5` Two panes ONLY landscape >=960 px; never portrait/tablet-portrait                             | I-38                                                                  | mockup-only |                                                                                  |
| `B8.6` Developer and device on separate lines; no eyebrow; full-width trust-recei…                   | I-38, PX-14                                                           | mockup-only |                                                                                  |
| `B8.7` <img> art same-origin: Worker CSP img-src widened exactly like the app pol…                   | I-38                                                                  | mockup-only |                                                                                  |
| `B8.8` No inline style/script on hosted pages                                                        | I-38                                                                  | built       |                                                                                  |
| `B8.9` Key on-ramp and Done header "<Product> · <Developer>" (no "wants you to si…                   | PX-12, PX-14, I-38                                                    | mockup-only |                                                                                  |
| `B8.10` Consent Allow/Deny equal size, scopes listed before the buttons                              | PX-14, I-34                                                           | mockup-only |                                                                                  |
| `B8.11` Provider button fills only from Apple/Google/Steam allowed sets, never the…                  | PX-12, I-38                                                           | mockup-only |                                                                                  |
| `B8.12` Phone-only lilac hairline rejected                                                           | I-38, PX-12                                                           | mockup-only |                                                                                  |
| `B8.13` Sign-in star field stays                                                                     | I-38, PX-12                                                           | partial     |                                                                                  |
| `B9.1` Device-code ALWAYS ends with an explicit "Sign in on <device>?" confirm wi…                   | I-37                                                                  | mockup-only |                                                                                  |
| `B9.2` Scan is never approval; TV keeps seeing "pending" until confirmed                             | I-37                                                                  | mockup-only |                                                                                  |
| `B9.3` Device-code page cannot name the product before the code resolves                             | I-37, PX-14                                                           | partial     | Negative test: the device-code page cannot name the product before the code res… |
| `B9.4` Design rule only: no wire change                                                              | I-37                                                                  | n/a         |                                                                                  |
| `B10.1` DL1-DL18 kept                                                                                | UK-41, UK-55                                                          | partial     |                                                                                  |
| `B10.2` Passport = DL1 start pane: art/icon only, title + act in end pane top-alig…                  | UK-05, UK-07, UK-09, UK-11, UK-12, UK-59                              | mockup-only |                                                                                  |
| `B10.3` QR ONLY on TV/console/pad-only screens and offline request codes (NOT desk…                  | UK-11, UK-50, UK-35, UK-27                                            | partial     | B10: the toast keeps title-safe placement and the host-owns-pause rule (set pro… |
| `B10.4` Inline form is the default presentation (D-79); sheet is the labelled alte…                  | UK-05, UK-04                                                          | mockup-only |                                                                                  |
| `B10.5` Device limit on key path = browser mode "Replace a device" (no key-authent…                  | PX-15, UK-42                                                          | mockup-only |                                                                                  |
| `B10.6` Desktop kit never draws title bar/caption buttons                                            | UK-09, UK-10, UK-11, UK-12                                            | mockup-only |                                                                                  |
| `B10.7` No static accent line under title bars (shimmer = loading)                                   | UK-55, UK-05                                                          | mockup-only |                                                                                  |
| `B10.8` Loading per DL7 (no part-filled bar)                                                         | UK-55, UK-02b                                                         | partial     |                                                                                  |
| `B10.9` Catalog copy only (DL8)                                                                      | UK-55, UK-02b                                                         | built       |                                                                                  |
| `B10.10` "Set by <developer>" unless host supplies a reason; provenance groups "Fro…                 | UK-05, UK-02b                                                         | partial     |                                                                                  |
| `B10.11` External-action glyph vs ellipsis                                                           | UK-55, UK-05                                                          | mockup-only |                                                                                  |
| `B10.12` GUI key field visible+private (no autocorrect/keyboard learning/log/--json…                 | UK-05, UK-07, UK-14 (done), UK-51                                     | partial     |                                                                                  |
| `B10.13` Refusals use triangle not cross; exit codes per UK-51 (refused gate 4, sta…                 | UK-51                                                                 | mockup-only |                                                                                  |
| `B10.14` Terminal board adds pipe quadrant + 40/32-col frames                                        | UK-56, UK-59                                                          | mockup-only |                                                                                  |
| `B10.15` Host-owns-pause-and-input rule for game kits (set process_mode so kit dial…                 | UK-11, UK-50                                                          | mockup-only |                                                                                  |
| `B10.16` Native Windows (UK-60) and native GNOME (UK-61) kits registered OPTIONAL/P…                 | UK-60, UK-61                                                          | built       |                                                                                  |
| `B10.17` KDE form for Qt only (folded into UK-12 brief)                                              | UK-12                                                                 | mockup-only |                                                                                  |
| `B11.1` Marketing exceptions (dark-only, parallax/tilt/loops, big display type, tw…                  | DOC-13, DOC-14                                                        | n/a         | The doc amendments had no owner: new package DOC-14.                             |
| `B11.2` Site embedded React kit demo is stale: playground built here (UK-62), webs…                  | UK-62                                                                 | mockup-only |                                                                                  |
| `B11.3` Site code examples live here, type-checked per SDK                                           | DOC-13                                                                | mockup-only |                                                                                  |
| `B11.4` Cloud Sync marketing labelled "In development", synced-settings-only claim…                  | U-05, U-20                                                            | n/a         | Hand-off note: when U-05/U-20 ship, the website owner removes the 'In developme… |
| `B11.5` Marketing names are page titles only; body copy uses glossary words; mappi…                  | DOC-13, DOC-14                                                        | n/a         | The doc amendments had no owner: new package DOC-14.                             |
| `B12.1` Docked portal header                                                                         | PX-31, PX-27                                                          | built       |                                                                                  |
| `B12.2` H1 48/52 desktop, 32/36 phone, no full stop, no slogan label                                 | PX-27, PX-31                                                          | mockup-only |                                                                                  |
| `B12.3` Art-led full-width 16:9 tiles; outlined tile actions; solid only hero, pro…                  | PX-27, PX-30                                                          | partial     |                                                                                  |
| `B12.4` No chartreuse in the portal                                                                  | PX-30, PX-31                                                          | partial     |                                                                                  |
| `B12.5` Account nav: Profile - Sign-in methods - Connected apps - Packages - Where…                  | PX-31, PX-W19, I-34                                                   | partial     |                                                                                  |
| `B12.6` Package tokens ONLY in Account > Packages + one pointer row on product page                  | PX-31, PX-28                                                          | partial     |                                                                                  |
| `B12.7` Lapsed page: state once, no "Not included" row, Renew only in License card                   | PX-28                                                                 | mockup-only |                                                                                  |
| `B12.8` Sign-in has no art beside the card except optional requesting-product cove…                  | PX-33                                                                 | mockup-only |                                                                                  |
| `B12.9` Take/Activate: account row, anti-phishing line on device code, "No license…                  | PX-29, PX-12, I-37, PX-32                                             | mockup-only |                                                                                  |
| `B13.1` Strip guide-introduced taglines/slogans/restating ledes/"In your account"/…                  | UK-55, PX-26, ST-48, P0-36                                            | partial     | Not mechanisable: enforced by the acceptance block's copy row plus the recorded… |
| `B13.2` Catalog strings win                                                                          | UK-55, P0-36                                                          | partial     |                                                                                  |
| `B13.3` Eyebrow repeating breadcrumb banned                                                          | ST-48, UK-55                                                          | mockup-only |                                                                                  |
| `B14.1` Acceptance block appended to briefs of every todo/in-progress/blocked UI-s…                  | UK-55                                                                 | partial     | The Screen acceptance block was appended to the 12 selected packages that lacke… |
| `B14.2` Canonical text in EXPERIENCE §7.3                                                            | UK-55                                                                 | built       |                                                                                  |
| `B14.3` UK-55 gains accent-as-status and section-index lints                                         | UK-55                                                                 | mockup-only |                                                                                  |
| `B14.4` PX-26 gains 400% reflow, forced-colors, prefers-contrast, labelled-scroll-…                  | PX-26                                                                 | mockup-only |                                                                                  |
| `B14.5` UI-KITS §7.1 gains a 400% row                                                                | UK-55, PX-26                                                          | mockup-only |                                                                                  |
| `B14.6` Guide "must not" invariants per component (UI-KITS §4.1)                                     | UK-55, UK-02b                                                         | mockup-only | Write the per-component 'must not' invariants (UI-KITS 4.1) as fixtures/lint ru… |
| `B14.7` Verification recipe: a matrix cell is complete only with runtime evidence…                   | UK-41, UK-59                                                          | partial     | UK-41 requires an evidence ledger: a matrix cell is complete only with runtime…  |
| `B15.1` UI-KITS §4.3 remove "QR beside the code at >=560 px" (retired by DL14)                       | DOC-14                                                                | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B15.2` UI-KITS §4.2 + web docs: remove publishableKey (SETUP D18)                                   | DOC-13, DOC-14                                                        | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B15.3` EXPERIENCE §0.2 settings hub list (ST-08 4 tabs) and §5.1 top bar                            | ST-08, DOC-14                                                         | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B15.4` ADMIN §6.1/§6.2 stale (Products, Recent products, Trust & SDK)                               | ST-44, ST-45, DOC-14                                                  | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B15.5` BRAND §10 "no 500/600" vs §1.6; table row heights 36/44 vs 52/64 settled a…                  | UK-58, ST-48, DOC-14                                                  | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B15.6` ADMIN §0.5 source-precedence note; BRAND §14 additions (naming table, four…                  | UK-58, DOC-14                                                         | mockup-only | The doc amendments had no owner: new package DOC-14.                             |
| `B16.1` Admin route ledger: ONE map old page id -> new route; each removed id gets…                  | ST-49                                                                 | partial     |                                                                                  |
| `B16.2` Reword ST-08 "legacy redirects with a banner for one release"                                | ST-08, ST-49                                                          | mockup-only |                                                                                  |
| `B16.3` U-27 deletes override migration (do not adopt the study)                                     | ST-49                                                                 | n/a         |                                                                                  |
| `B16.4` Studies 372-387 are a coverage checklist only                                                | —                                                                     | n/a         | informational; nothing to build                                                  |
| `B16.5` Propose 4 new admin mockups (platform-status, platform-activity, settings-…                  | —                                                                     | mockup-only | the four new admin mockups and the listed state gaps exist in brand/mockups (ad… |
| `B17.1` Focus ring takes the accent of the service the element references (data-se…                  | ST-48, UK-58, UK-55                                                   | partial     |                                                                                  |
| `B17.2` Active/selected nav item takes the service accent                                            | ST-45, ST-48                                                          | built       |                                                                                  |
| `B17.3` Hover state takes service accent                                                             | ST-48, UK-58                                                          | mockup-only |                                                                                  |
| `B17.4` Checked controls (checkbox, radio, switch, segmented, tab, chip) take serv…                  | ST-48, UK-58                                                          | partial     |                                                                                  |
| `B17.5` Per-element data-service on mixed lists (a Config row inside a lime Licens…                  | ST-48                                                                 | mockup-only |                                                                                  |
| `B17.6` Text/borders use -fg token, fills use base token; contrast 3:1 UI, 4.5:1 t…                  | UK-58                                                                 | partial     |                                                                                  |
| `B17.7` Status never drawn in a service accent (accent-as-status)                                    | UK-55, UK-63                                                          | mockup-only | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `B17.8` Selection carries a non-colour cue (check/dot/bar + label)                                   | UK-55, ST-48                                                          | built       |                                                                                  |
| `B17.9` One filled primary per state; primary fill stays neutral ink (not service…                   | UK-58, ST-48                                                          | mockup-only |                                                                                  |
| `B17.10` Core/platform screens use core violet; kits follow platform look with prod…                 | ST-48, UK-05                                                          | built       |                                                                                  |
| `OR-terse-copy` Terse copy: no extraneous text, each fact once, in the reader's terms                | UK-55, P0-36, ST-48                                                   | partial     | Not mechanisable: enforced by the acceptance block's copy row plus the recorded… |
| `OR-responsive-matrix` Every screen and drop-in kit adapts to its window (landscape/portrait), te…   | PX-26, UK-55, UK-41, UK-59, UK-63                                     | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `OR-service-accent-states` Interactive and context colour follows the referenced service (B17)       | ST-48, UK-55, UK-58, UK-63                                            | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `OR-ux-review-per-screen` pkey-ux-reviewer BUILT mode on every built screen before done              | —                                                                     | n/a         | implemented by the UX coverage change itself: check.mjs --ux, --ux-review and t… |
| `OR-kits-polaris-default` UI kits default to the Polaris look with theming/native preset; piecemeal… | UK-03, UK-04, UK-05, UK-17, UK-18, UK-19, UK-20, UK-31, UK-41, UK-02b | partial     | A 'polaris-key / native' preset test per framework is a ui-matrix row in UK-02b… |
| `OR-fullbleed-art` Full-bleed art: art fills its frame, no name over art, no canvas pixel rea…       | PX-30, PX-27                                                          | partial     | Assert full-bleed 16:9 art and no text drawn over customer art.                  |
| `OR-tablet-table-regions` Tablet tables are labelled, focusable scroll regions (sticky first column) | ST-48, PX-26, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `OR-touch-44` 44 px touch targets on customer and touch surfaces (>=24 px with separatio…            | PX-26, UK-55, UK-63                                                   | partial     | Console and portal were not covered by the UK-55 lint and e2e rows: new package… |
| `OR-motion-reduced` Motion tokens only, reduced motion is an instant swap, durations <=480 ms        | MO-13, UK-58                                                          | built       |                                                                                  |
| `OR-a11y-acceptance-block` Accessibility acceptance block in every UI-surface brief                  | UK-55                                                                 | n/a         | The Screen acceptance block was appended to the 12 selected packages that lacke… |

## 10. Design-doc sections (545)

Sections with no build item (history, questions, pointers) carry an exemption in the JSON and are summarised here; every requirement section is listed with its owners.

### BRAND (44 sections: 24 built, 15 partial, 1 mockup-only, 4 informational)

| Section                                                                                                      | Owners                                                 | In code     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------- |
| `1-kit-rules` Kit rules (restated from the launch kit)                                                       | UK-01 (done)                                           | built       |
| `1.1-two-marks` Two marks: Pinned K and Star Cut (Delivery)                                                  | UK-01 (done), UK-57                                    | partial     |
| `1.2-colour-kit-primitives` Colour: kit primitives (violet, gold, ground, rose reserved, no gradi…           | UK-01 (done)                                           | built       |
| `1.3-optical-cuts` Optical cuts chosen by displayed size                                                     | UK-01 (done)                                           | built       |
| `1.4-clear-space-and-lockups` Clear space and lockups (1/4 glyph, compact lockup < 48 px)                    | UK-01 (done), UK-57                                    | partial     |
| `1.5-powered-by-polaris-key` 'Powered by Polaris Key' badge rules and minimum sizes                          | UK-01 (done)                                           | built       |
| `1.6-type` Type: one variable Rubik, weights 400/500/600, 700 wordmark only                                  | UK-01 (done), UK-58, ST-50                             | partial     |
| `1.7-alt-text` Alt text for the three marks                                                                  | UK-01 (done)                                           | built       |
| `2-using-the-package` Using the package: consumer table, asset exports, email PNG rules                      | UK-01 (done)                                           | built       |
| `3-theme-mechanics` Theme mechanics: dark-first, system, persisted override, data-theme,…                    | UK-01 (done)                                           | built       |
| `4-token-reference` Token reference (umbrella: surfaces, text, borders, status, signed, s…                   | UK-01 (done), UK-58                                    | partial     |
| `4.1-surfaces` Surfaces: page/raised/overlay/sunken                                                          | UK-01 (done)                                           | built       |
| `4.2-text` Text tokens strong/default/muted/subtle/on-accent with contrast floors                            | UK-01 (done)                                           | built       |
| `4.3-borders-and-focus` Borders and focus (focus follows the service per B17)                                | UK-01 (done), UK-58                                    | partial     |
| `4.4-status` Status colours success/warning(amber)/danger/info(violet) with fg/on/…                          | UK-01 (done)                                           | built       |
| `4.5-signed-gold-means-signed` Signed (gold) tokens: signed, -on, -border, -subtle, -mark                    | UK-01 (done)                                           | built       |
| `4.6-scales` Scales: space, radius, elevation, motion, type, kit tokens, JetBrains…                          | UK-01 (done), MO-01 (done), UK-58                      | partial     |
| `5-section-accents` Section accents (solid/fg/on/subtle) for eight services                                  | UK-01 (done)                                           | built       |
| `5.1-accent-rules` Rules the accents satisfy (hue bans, CIEDE2000 floors, WCAG)                              | UK-01 (done)                                           | built       |
| `5.2-the-table` Accent table: eight services with dark/light solid, fg                                       | UK-01 (done)                                           | built       |
| `5.4-using-accents` Using accents: chrome only; states follow the service (B17); primary…                    | UK-58, ST-48                                           | partial     |
| `6-the-section-bit` Section bit: no bit on core, bit in section accent, >= 48 px display…                    | UK-01 (done)                                           | built       |
| `7-usage-conventions` Usage conventions (umbrella 7.1-7.7)                                                   | UK-01 (done)                                           | partial     |
| `7.1-which-mark` Which mark where (Pinned K console/portal/docs; Star Cut delivery; no…                      | UK-01 (done), UK-57                                    | partial     |
| `7.2-powered-by-polaris-key` Powered-by placement: integrators only, never on our own surfaces, op…          | UK-01 (done)                                           | built       |
| `7.3-gold-means-signed` Gold means signed in console rows and chips                                          | UK-01 (done)                                           | built       |
| `7.4-focus` Focus ring 2 px with 2 px offset, always visible                                                 | UK-01 (done), UK-58                                    | partial     |
| `7.5-motion` Motion: tokens only, reduced motion swaps instantly, only loaders loo…                          | MO-01 (done), MO-02 (done), MO-03 (done), UK-01 (done) | built       |
| `7.6-console-density-and-layout` Console density and layout for data tables (rows 36/44, 64 px header,…      | ST-48, PX-26                                           | partial     |
| `7.7-empty-states-and-illustration` Empty states: stationary star motif, one line/one line/one primary ac…   | ST-48, PX-26                                           | partial     |
| `8-the-bytes-host-dl-plrs-im` dl.plrs.im landing page contract (Star Cut, Delivery lockup, no listi…         | —                                                      | built       |
| `8.1-what-the-page-omits-and-why` Documented deviations of the shipped landing (system font, no OG, no…      | —                                                      | built       |
| `8.2-the-registry-host-pkg-plrs-im` pkg.plrs.im landing page under the same contract                         | —                                                      | built       |
| `9-accessibility` Accessibility: WCAG 2.2 AA both themes, not colour alone, labelled co…                     | UK-01 (done), PX-20 (done), UK-15 (done)               | built       |
| `10-do-and-dont` Do and don't list                                                                           | UK-01 (done)                                           | partial     |
| `11-migration-from-the-consoles-pk-tokens` Migration map from console --pk-\* HSL tokens to new tokens       | —                                                      | built       |
| `12-native-consumers` Native consumers get generated tokens (Godot, SwiftUI, Compose, Pytho…                 | UK-01 (done), UK-29                                    | partial     |
| `13-changing-the-system` Process: edit source.ts, gen, tests, update tables; services.json req…              | UK-01 (done)                                           | built       |
| `owner-decisions-2026-10-03` Star Cut = Polaris Key Delivery; no bit on core; palette approved; no…          | UK-01 (done), UK-57                                    | partial     |
| `v2-action-neutral-and-service-icons` Brand v2 assets/tokens named in the brief: action-neutral role (UK-58… | UK-58, UK-57, ST-48, ST-50, DOC-14                     | mockup-only |

### UI-KITS (82 sections: 12 built, 49 partial, 14 mockup-only, 7 informational)

| Section                                                                                                          | Owners                                                                             | In code     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| `owner-decisions-2026-10-05` Owner decision table (locales, Apple floors, Lit, Ink fallback, JetBr…              | UK-01 (done), UK-02a (done), UK-04, UK-07, UK-11, HA-13, HA-14                     | partial     |
| `design-language-v2` Design language v2 umbrella: DL1-DL18, lint + matrix + boards                               | UK-55, UK-56, UK-59, UK-41                                                         | partial     |
| `1-the-polaris-key-default-look` The Polaris Key default look (umbrella 1.1-1.6)                                 | UK-01 (done), UK-05, UK-07, UK-09, UK-11, UK-12                                    | partial     |
| `1.1-the-rule` Polaris look is the default, native is the opt-out                                                | UK-47, UK-49, UK-50, UK-05, UK-07                                                  | partial     |
| `1.2-the-product-is-the-hero` Product is the hero: icon/monogram, name, accent from registered pres…             | HA-13, HA-14, UK-47, UK-49, UK-50, UK-41                                           | partial     |
| `1.3-three-layers-in-every-kit` Three layers: drop-in, styled parts, headless model                              | UK-03, UK-04, UK-05, UK-07, UK-09, UK-11, UK-12                                    | partial     |
| `1.4-platform-adapted-clearly-polaris-key` Platform-adapted layouts (glass on 26, Material 3 Expressive, dialog… | UK-07, UK-08, UK-09, UK-10, UK-11, UK-12, UK-13 (done), UK-14 (done), UK-56        | partial     |
| `1.5-nothing-dated-the-hard-rules` Hard rules: no dated patterns (11 rules) enforced by lint                     | UK-15 (done), UK-55                                                                | built       |
| `1.6-marks` Kit screens show no Polaris mark; Powered-by opt-in                                                  | UK-55, UK-47, UK-49, UK-50                                                         | partial     |
| `2-tokens-in-every-kit` Tokens in every kit (umbrella)                                                           | UK-01 (done)                                                                       | built       |
| `2.1-generated-never-hand-copied` Generated tokens: kit.css, kit.ts, per-platform outputs, Python QSS,…          | UK-01 (done)                                                                       | partial     |
| `2.2-the-drift-gate` Drift gate: gen brand --check over all outputs                                              | UK-01 (done)                                                                       | built       |
| `3-one-theme-api` One theme API (umbrella)                                                                       | UK-03, UK-05                                                                       | partial     |
| `3.1-the-shape` Theme shape: preset, scheme, accent, density, motion, copy                                       | UK-03, UK-05, UK-07, UK-09, UK-11, UK-12                                           | partial     |
| `3.2-where-it-is-set-per-kit` Where theme is set per kit                                                         | UK-05, UK-07, UK-09, UK-11, UK-12, UK-04                                           | partial     |
| `3.3-the-accent-resolver` Accent resolver (white-first resolveAccent) with shared vectors in ev…                 | UK-01 (done)                                                                       | built       |
| `3.4-the-native-preset` The native preset follows the host                                                       | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11                                    | partial     |
| `3.5-bring-your-own-design-system` Bring your own design system (token export, host themes)                      | UK-31                                                                              | partial     |
| `4-the-component-catalogue` Component catalogue (umbrella)                                                       | UK-03, UK-04, UK-05, UK-07, UK-09, UK-11, UK-12                                    | partial     |
| `4.1-the-set-and-the-names` Component set and naming across kits                                                 | UK-04, UK-05, UK-07, UK-09, UK-11, UK-12                                           | partial     |
| `4.2-the-drop-in-flows-complete` Drop-in flows complete; one call per kit (DL18)                                 | UK-05, UK-07, UK-09, UK-11, UK-12, UK-47, UK-49, UK-50                             | partial     |
| `4.3-key-components-in-detail` Key components in detail (umbrella; Welcome, SignIn, DeviceLimit, Upd…            | UK-05, UK-07, UK-09, UK-11, UK-12                                                  | partial     |
| `4.3-welcome-and-activate` Welcome and Activate screens                                                          | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11                                    | partial     |
| `4.3-signin-and-signinhandoff` SignIn and SignInHandoff (code view, QR rules, handoff)                           | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, I-37                              | partial     |
| `4.3-devicelimit` DeviceLimit screen (neutral callout, fix primary)                                              | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11                                    | partial     |
| `4.3-updateprompt-and-updateprogress` UpdatePrompt and UpdateProgress                                            | UK-47, UK-49, UK-50, UK-05, UK-06, UK-07, UK-09, UK-11                             | partial     |
| `4.3-accountandlicense-and-settings` AccountAndLicense and Settings                                              | UK-05, UK-07, UK-08, UK-09, UK-11, UK-12                                           | partial     |
| `4.4-accessibility-every-kit` Accessibility in every kit (screen reader, focus, targets, contrast)               | UK-15 (done), UK-55                                                                | partial     |
| `4.5-powered-by` Powered by (optional, off by default)                                                           | UK-01 (done)                                                                       | built       |
| `4.6-states-and-copy-are-data` States and copy are data: shared fixtures and ui.\* parity rows                   | UK-02a (done), UK-02b                                                              | partial     |
| `4.7-internationalisation` Internationalisation: nine launch locales, ICU catalogs, RTL-safe                     | UK-02a (done), UK-55                                                               | built       |
| `4.8-motion` Kit motion (reduced motion = 0, shimmer holds still)                                                | MO-01 (done), UK-03                                                                | partial     |
| `5-frameworks-and-architecture` Frameworks and architecture (umbrella)                                           | UK-03, UK-04                                                                       | mockup-only |
| `5.1-the-matrix` Framework matrix (kit per framework, must/should/could)                                         | UK-04, UK-05, UK-06, UK-17, UK-18, UK-19, UK-20, UK-21, UK-31                      | partial     |
| `5.2-one-state-machine-conformance-pinned` One state machine, conformance-pinned                                 | UK-02b, UK-03                                                                      | mockup-only |
| `5.3-packaging` Packaging (per-kit packages, peer deps)                                                          | UK-04, UK-05, UK-06                                                                | partial     |
| `6-samples-and-docs` Samples and docs (umbrella)                                                                 | UK-16 (done)                                                                       | partial     |
| `6.1-a-sample-per-kit` A sample per kit                                                                          | UK-05, UK-07, UK-09, UK-11, UK-12, UK-41                                           | partial     |
| `6.2-docs` Docs: overview, theming, localisation, component and framework pages                                  | UK-16 (done), DOC-08b, UK-41                                                       | built       |
| `7-visual-qa` Visual QA (umbrella)                                                                               | UK-15 (done)                                                                       | built       |
| `7.1-baselines-per-kit-both-themes` Baselines per kit, both themes, size matrix rows                             | UK-15 (done), UK-41, UK-59                                                         | partial     |
| `7.2-gates` Gates: lint, baselines, report in CI                                                                 | UK-15 (done)                                                                       | built       |
| `7.3-the-modernity-lint` Modernity lint rules incl. string lint and orphan check                                 | UK-15 (done), UK-55                                                                | built       |
| `7.4-design-review` Design review (pkey-ux-reviewer verdict good or better)                                      | UK-41, UK-59                                                                       | n/a         |
| `8-mockups` Mockups: kit boards per platform                                                                     | UK-56, UK-59                                                                       | mockup-only |
| `8-mockups-web` Mockup board: Web (React and elements)                                                           | UK-59, UK-56                                                                       | mockup-only |
| `8-mockups-ios-26` Mockup board: iOS 26 (SwiftUI, Liquid Glass)                                                  | UK-59                                                                              | mockup-only |
| `8-mockups-ipados-visionos-tvos-watchos` Mockup board: iPadOS, visionOS, tvOS and watchOS                        | UK-56, UK-59                                                                       | mockup-only |
| `8-mockups-android` Mockup board: Android (Compose, Material 3 Expressive)                                       | UK-59                                                                              | mockup-only |
| `8-mockups-macos-26` Mockup board: macOS 26 (SwiftUI; Electron and Tauri)                                        | UK-56                                                                              | mockup-only |
| `8-mockups-windows-11-gnome` Mockup board: Windows 11 and GNOME                                                  | UK-56                                                                              | mockup-only |
| `8-mockups-qt` Mockup board: Qt (Qt Quick and QWidget)                                                           | UK-56                                                                              | mockup-only |
| `8-mockups-godot` Mockup board: Godot (Control nodes)                                                            | UK-59                                                                              | mockup-only |
| `8-mockups-terminal` Mockup board: Terminal (Node and Python CLIs, Textual)                                      | UK-59                                                                              | mockup-only |
| `10-build-plan` Build plan: must/should/could WP table                                                           | UK-41                                                                              | partial     |
| `10-must` Must tier build items (UK-01 to UK-16, UK-40, UK-41)                                                   | UK-41                                                                              | partial     |
| `10-should` Should tier (UK-17 to UK-30)                                                                         | UK-17, UK-18, UK-19, UK-20, UK-21, UK-23, UK-24, UK-25, UK-26, UK-27, UK-28, UK-29 | mockup-only |
| `10-could` Could tier (UK-31 to UK-39)                                                                           | UK-31, UK-32, UK-33, UK-34, UK-35, UK-38, UK-39                                    | mockup-only |
| `DL1` DL1 Layout follows container shape                                                                         | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12, UK-56, UK-59               | partial     |
| `DL2` DL2 Interruptions over the app; blocking owns the window; panes join…                                      | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12                             | partial     |
| `DL3` DL3 One spacing scale with density steps                                                                   | UK-55, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12                      | partial     |
| `DL4` DL4 One primary per screen                                                                                 | UK-15 (done), UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12               | built       |
| `DL5` DL5 The product is the identity (no Polaris mark)                                                          | UK-55, HA-13, HA-14, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12        | partial     |
| `DL6` DL6 Resolvable refusal is a neutral callout, fix is the primary                                            | UK-55, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12                      | partial     |
| `DL7` DL7 Errors under the control; every state designed                                                         | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12, UK-02b                     | partial     |
| `DL8` DL8 Copy verbatim from catalogs                                                                            | UK-02a (done), UK-15 (done), UK-55                                                 | built       |
| `DL9` DL9 Focus always somewhere useful and visible                                                              | UK-55, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12                      | partial     |
| `DL10` DL10 Targets and type have platform floors                                                                | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12, UK-15 (done)               | partial     |
| `DL11` DL11 Text scales with the person's setting                                                                | UK-55, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12                      | partial     |
| `DL12` DL12 Three weights                                                                                        | UK-58, UK-55, ST-50                                                                | partial     |
| `DL13` DL13 Two presets: native and polaris-key                                                                  | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12, UK-58                      | partial     |
| `DL14` DL14 QR codes and links fail closed                                                                       | UK-55, UK-51, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12               | partial     |
| `DL15` DL15 Every screen passes the size matrix                                                                  | UK-15 (done), UK-41, UK-59, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12 | partial     |
| `DL16` DL16 Motion and transparency follow settings                                                              | MO-01 (done), UK-03, UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12        | partial     |
| `DL17` DL17 Content stays inside the safe area                                                                   | UK-47, UK-49, UK-50, UK-05, UK-07, UK-09, UK-11, UK-12                             | partial     |
| `DL18` DL18 One line to drop in, then customise                                                                  | UK-05, UK-07, UK-09, UK-11, UK-12, UK-47                                           | partial     |
| `language-matrix` Application matrix: one row per not-done UK package, rules + in-this-…                         | UK-56, UK-59, UK-41                                                                | n/a         |

### PORTAL (71 sections: 23 built, 23 partial, 10 mockup-only, 15 informational)

| Section                                                             | Owners                                                                                                                                                                                                                                | In code     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `0.1` What "done" looks like                                        | PX-01 (done), PX-02 (done), PX-08 (done), PX-16 (done), PX-12, PX-13 (done)                                                                                                                                                           | partial     |
| `0.2` Design principles                                             | PX-01 (done), PX-02 (done), PX-04 (done), PX-09, PX-12                                                                                                                                                                                | partial     |
| `0.3` The brand contract                                            | UK-57, UK-58, PX-27, PX-30                                                                                                                                                                                                            | mockup-only |
| `3.1` Model                                                         | PX-W12 (done), PX-W17 (done), PX-13 (done), I-05 (done), PX-W19, PX-31                                                                                                                                                                | partial     |
| `3.2` Global elements                                               | PX-01 (done), PX-08 (done), PX-29                                                                                                                                                                                                     | built       |
| `3.3` Routes                                                        | PX-01 (done), PX-10 (done), PS-05 (done), PX-13 (done)                                                                                                                                                                                | partial     |
| `3.4` Entry points                                                  | PX-W8 (done), PX-17 (done), PX-10 (done), PX-14                                                                                                                                                                                       | partial     |
| `4.1` The login card                                                | PX-05 (done), PX-12, PX-14, UK-02b                                                                                                                                                                                                    | partial     |
| `4.2` Product context                                               | PX-05 (done)                                                                                                                                                                                                                          | built       |
| `4.3` Known account: "You usually sign in with Steam"               | PX-12, PX-W15 (done)                                                                                                                                                                                                                  | mockup-only |
| `4.4` Enter the code                                                | PX-05 (done), PX-W4 (done)                                                                                                                                                                                                            | built       |
| `4.5` Use a license key                                             | PX-05 (done), PX-06 (done)                                                                                                                                                                                                            | built       |
| `4.6` Key entry: the account upgrade (skippable, then forced)       | PX-12, PX-W9 (done)                                                                                                                                                                                                                   | mockup-only |
| `4.7` App sign-in: the card header                                  | PX-14, PX-W13 (done), PX-33, I-13, I-16 (done)                                                                                                                                                                                        | mockup-only |
| `4.8` App sign-in: native app steps                                 | PX-14, PX-12                                                                                                                                                                                                                          | mockup-only |
| `4.9` App sign-in: device code (TV, console)                        | PX-14, PX-15                                                                                                                                                                                                                          | mockup-only |
| `4.10` Add another way to sign in (nudge)                           | PX-15, PX-12                                                                                                                                                                                                                          | mockup-only |
| `4.11` Link an existing account                                     | PX-15, PX-W12 (done)                                                                                                                                                                                                                  | partial     |
| `4.12` Library: empty                                               | PX-02 (done), PX-16 (done)                                                                                                                                                                                                            | built       |
| `4.13` Library: one product                                         | PX-02 (done), PX-08 (done), PX-30                                                                                                                                                                                                     | partial     |
| `4.14` Library: a few products (2–7)                                | PX-02 (done), PX-24 (done), PX-27                                                                                                                                                                                                     | partial     |
| `4.15` Library: many products (8+), grid and list                   | PX-03 (done), MO-07 (done), PX-27                                                                                                                                                                                                     | built       |
| `4.16` Discover                                                     | PX-W10 (done), PX-16 (done), PS-05 (done), PX-27, PS-12                                                                                                                                                                               | partial     |
| `4.17` Activate license: the modal                                  | PX-06 (done), PX-17 (done), PX-29                                                                                                                                                                                                     | built       |
| `4.18` Activate license: deep link                                  | PX-06 (done), PX-17 (done)                                                                                                                                                                                                            | built       |
| `4.19` Activate license: errors                                     | PX-06 (done), PX-17 (done)                                                                                                                                                                                                            | built       |
| `4.20` Product page                                                 | PX-04 (done), PX-09, PX-18, PX-28, LX-15, PX-W6 (done)                                                                                                                                                                                | partial     |
| `4.21` Package token created                                        | PX-11 (done)                                                                                                                                                                                                                          | built       |
| `4.22` Remove a device (inline)                                     | PX-04 (done), MO-06 (done)                                                                                                                                                                                                            | built       |
| `4.23` Sign in with another device                                  | PX-15, PX-W14 (done)                                                                                                                                                                                                                  | mockup-only |
| `4.24` Approve a new device                                         | PX-15, PX-W14 (done)                                                                                                                                                                                                                  | mockup-only |
| `4.25` Device limit: focused flow                                   | PX-10 (done), PX-29                                                                                                                                                                                                                   | built       |
| `4.26` Account                                                      | PX-07 (done), PX-13 (done), PX-22 (done), PX-W19, PX-31                                                                                                                                                                               | partial     |
| `4.27` Jump to a product (⌘K)                                       | PX-03 (done)                                                                                                                                                                                                                          | built       |
| `4.28` Not found and errors                                         | PX-04 (done), PX-01 (done)                                                                                                                                                                                                            | built       |
| `4.29` Confirm your email (first provider sign-in)                  | PX-21, PX-W15 (done), PX-12                                                                                                                                                                                                           | mockup-only |
| `4.30` Account → Profile                                            | PX-22 (done), PX-W16 (done)                                                                                                                                                                                                           | built       |
| `5.2` New components                                                | PX-01 (done), PX-05 (done), PX-12, PX-14, PX-15, PX-18, PX-21                                                                                                                                                                         | partial     |
| `5.3` Status model                                                  | PX-02 (done), PX-08 (done), PX-28                                                                                                                                                                                                     | partial     |
| `5.4` Quick action resolution                                       | PX-02 (done), PX-08 (done), PX-09                                                                                                                                                                                                     | partial     |
| `6.1` Rules                                                         | PX-01 (done), PX-20 (done), UK-02a (done), P0-36                                                                                                                                                                                      | partial     |
| `6.2` Voice samples                                                 | PX-01 (done), UK-02a (done), P0-36                                                                                                                                                                                                    | partial     |
| `6.3` Emails                                                        | PX-W7 (done)                                                                                                                                                                                                                          | built       |
| `6.4` Error copy                                                    | PX-01 (done)                                                                                                                                                                                                                          | built       |
| `7` Layout and visual details                                       | PX-26, UK-57, PX-27                                                                                                                                                                                                                   | partial     |
| `8` Responsive rules                                                | PX-01 (done), PX-20 (done), PX-26                                                                                                                                                                                                     | built       |
| `9` Accessibility                                                   | PX-20 (done)                                                                                                                                                                                                                          | built       |
| `10.2` Gaps the Worker must close                                   | PX-W1 (done), PX-W2 (done), PX-W3 (done), PX-W5 (done), PX-W6 (done), PX-W7 (done), PX-W8 (done), PX-W9 (done), PX-W10 (done), PX-W12 (done), PX-W13 (done), PX-W14 (done), PX-W15 (done), PX-W16 (done), PX-W17 (done)               | built       |
| `11.1` Phase A: rebuild on today's API (no Worker changes)          | PX-01 (done), PX-02 (done), PX-03 (done), PX-04 (done), PX-05 (done), PX-06 (done), PX-07 (done)                                                                                                                                      | built       |
| `11.2` Phase W: Worker additions                                    | PX-W1 (done), PX-W2 (done), PX-W3 (done), PX-W4 (done), PX-W5 (done), PX-W6 (done), PX-W7 (done), PX-W8 (done), PX-W9 (done), PX-W10 (done), PX-W12 (done), PX-W13 (done), PX-W14 (done), PX-W15 (done), PX-W16 (done), PX-W17 (done) | built       |
| `11.3` Phase B: features on the new API, S-16 and S-17              | PX-08 (done), PX-09, PX-12, PX-14, PX-15, PX-18, PX-21                                                                                                                                                                                | partial     |
| `B` Appendix B · Fixed from the three-direction critique (kept)     | PX-02 (done), PX-04 (done)                                                                                                                                                                                                            | built       |
| `C` Appendix C · Owner decisions applied (2026-10-04)               | PX-12, PX-13 (done), PX-14, PX-15, PX-W17 (done)                                                                                                                                                                                      | partial     |
| `D` Appendix D · Design QA fixes (2026-10-04)                       | PX-04 (done), PX-13 (done), PX-15, PX-12                                                                                                                                                                                              | partial     |
| `E` Appendix E · Owner decisions applied, second round (2026-10-04) | PX-21, PX-22 (done), PX-W15 (done), PX-W16 (done), PX-W17 (done)                                                                                                                                                                      | partial     |
| `F` Appendix F · Owner feedback applied (2026-10-04, third round)   | PX-12, PX-06 (done)                                                                                                                                                                                                                   | partial     |

### ADMIN (83 sections: 46 built, 16 partial, 1 mockup-only, 20 informational)

| Section                                                        | Owners                                                                             | In code     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| `0.1` What done looks like                                     | ST-48, P0-37                                                                       | partial     |
| `0.2` Design principles                                        | —                                                                                  | built       |
| `0.3` Consuming brand                                          | UK-57, UK-58, ST-48, ST-50                                                         | partial     |
| `0.4` Stack decisions                                          | —                                                                                  | built       |
| `2.1` Navigation model (two tiers)                             | ST-45, A-21                                                                        | partial     |
| `2.2` Global elements (top bar, brand block, palette, account) | ST-48, ST-45                                                                       | partial     |
| `2.3` Sections and pages list                                  | ST-45, ST-49, A-21, ST-08                                                          | partial     |
| `2.4` Accent and mark mapping                                  | UK-57, UK-58, ST-48                                                                | partial     |
| `2.5` URL scheme                                               | ST-49                                                                              | built       |
| `2.6` Routing mechanics (nav.ts, routes.ts, hash router)       | P0-34                                                                              | built       |
| `2.7` Customer portal IA                                       | —                                                                                  | built       |
| `T1` Template T1 Overview                                      | ST-44, ST-41                                                                       | partial     |
| `T2` Template T2 Collection                                    | —                                                                                  | built       |
| `T3` Template T3 Record                                        | —                                                                                  | built       |
| `T4` Template T4 Settings                                      | ST-07, ST-08                                                                       | partial     |
| `T5` Template T5 Matrix                                        | —                                                                                  | built       |
| `T6` Template T6 Flow (wizard)                                 | ST-39, ST-43                                                                       | partial     |
| `T7` Template T7 Editor                                        | —                                                                                  | built       |
| `T8` Template T8 State pages                                   | P0-37                                                                              | built       |
| `3.9` View to template map                                     | —                                                                                  | built       |
| `4` Component system                                           | P0-37, ST-07                                                                       | partial     |
| `5.1` Action placement                                         | —                                                                                  | built       |
| `5.2` Destructive-action policy                                | —                                                                                  | built       |
| `5.3` Confirmed-by-default updates                             | —                                                                                  | built       |
| `5.4` Mutation invalidation table                              | —                                                                                  | built       |
| `5.5` Keyboard shortcuts                                       | —                                                                                  | built       |
| `5.6` Focus management                                         | —                                                                                  | built       |
| `5.7` URL state                                                | —                                                                                  | built       |
| `5.8` Copy rules                                               | ST-37 (done)                                                                       | built       |
| `5.9` Formats and error messages                               | —                                                                                  | built       |
| `5.10` Permissions and read-only (useCan)                      | ST-29, ST-31                                                                       | mockup-only |
| `5.11` Pills mean attention                                    | —                                                                                  | built       |
| `5.12` Motion                                                  | MO-02 (done), MO-04 (done), MO-08 (done), MO-09 (done), MO-11 (done), MO-12 (done) | built       |
| `6.1` Console home                                             | ST-44, ST-27                                                                       | partial     |
| `6.2` Product overview                                         | ST-41, ST-44, ST-47                                                                | partial     |
| `6.3.1` Releases collection                                    | A-22                                                                               | built       |
| `6.3.2` Release record                                         | A-22                                                                               | built       |
| `6.3.3` Channels lane view                                     | A-22, A-19                                                                         | built       |
| `6.3.4` Deliverables and pack record                           | P4-09 (done)                                                                       | built       |
| `6.3.5` Compatibility matrix and simulator                     | P4-15 (done)                                                                       | built       |
| `6.4` Distribution matrix                                      | P2b-06 (done)                                                                      | built       |
| `6.5.1` Licenses collection                                    | LX-30 (done), LX-29                                                                | partial     |
| `6.5.2` License record                                         | LX-14, LX-44                                                                       | partial     |
| `6.5.3` Tiers and Enrollment                                   | LX-44, ST-08                                                                       | built       |
| `6.6.1` Catalog read view                                      | U-32                                                                               | built       |
| `6.6.2` Catalog editor                                         | U-32                                                                               | built       |
| `6.6.3` Profiles and payload editing                           | —                                                                                  | built       |
| `6.6.4` Edge mint                                              | —                                                                                  | built       |
| `6.7` Keys and secrets                                         | ST-08                                                                              | built       |
| `6.8` Activity                                                 | ST-45, ST-04 (done)                                                                | partial     |
| `6.9` Settings (product)                                       | ST-07, ST-08                                                                       | partial     |
| `6.10.2` Portal Home                                           | PX-27, PX-08 (done)                                                                | built       |
| `6.10.3` Portal license and devices                            | PX-28, LX-15                                                                       | built       |
| `6.10.4` Portal downloads and Account                          | PX-09, PX-31                                                                       | built       |
| `7.2/chunk-1` Chunk 1 Platform migration                       | —                                                                                  | built       |
| `7.2/chunk-2` Chunk 2 Shell, nav, router, data layer           | P0-32, P0-34                                                                       | built       |
| `7.2/chunk-3` Chunk 3 Component system                         | P0-37                                                                              | built       |
| `7.2/chunks-4-10` Chunks 4-10 Area chunks                      | —                                                                                  | built       |
| `7.2/chunk-11` Chunk 11 Docs, a11y, visual baseline            | PX-26                                                                              | built       |
| `7.2/chunk-12` Chunk 12 Customer portal                        | PX-01 (done), PX-20 (done)                                                         | built       |
| `7.3` API additions A-1 to A-10                                | —                                                                                  | built       |
| `owner-decisions` Owner decisions: Platform section            | ST-45, ST-09                                                                       | built       |
| `ps06` PS-06: Polaris Key storefront                           | PS-06 (done)                                                                       | built       |

### EXPERIENCE (63 sections: 14 built, 28 partial, 2 mockup-only, 19 informational)

| Section                                                                      | Owners                                                               | In code     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------- |
| `0.2` Console information architecture                                       | ST-45, ST-08, ST-49, A-21, ST-44                                     | partial     |
| `J-1` Palette sources (pasted key, entities, actions, settings, pages, rece… | ST-10, ST-52                                                         | partial     |
| `J-2` One attention model                                                    | ST-44, ST-27                                                         | partial     |
| `J-3` Launch path (server setup model)                                       | ST-41, ST-47                                                         | partial     |
| `J-4` Cross-links and context                                                | LX-14                                                                | partial     |
| `S1` S1 Create a product                                                     | ST-43, ST-42                                                         | built       |
| `S2` S2 First release and update feed                                        | ST-08, ST-41, A-32                                                   | partial     |
| `S3` S3 Licenses, tiers and auto-issue                                       | LX-29, LX-36, P2-10                                                  | partial     |
| `S4` S4 Services, catalog, identity                                          | ST-07, ST-08, ST-14, U-32                                            | partial     |
| `S5` S5 Storefronts                                                          | A-21, A-22, A-23                                                     | built       |
| `S6` S6 Package feeds and tokens                                             | F-33, F-34                                                           | built       |
| `O1` O1 Support: device limit / license not working                          | LX-14, LX-27, LX-44, LX-14a (done)                                   | partial     |
| `O2` O2 Bad release: halt and roll back                                      | A-22                                                                 | built       |
| `O3` O3 Rotate a signing key                                                 | —                                                                    | built       |
| `O4` O4 Setting change impact                                                | ST-07, ST-16, ST-04 (done)                                           | partial     |
| `O5` O5 Platform Status                                                      | ST-45                                                                | partial     |
| `O6` O6 Review activity                                                      | ST-45, ST-04 (done)                                                  | partial     |
| `O7` O7 Off-console alerts                                                   | ST-27, ST-44                                                         | mockup-only |
| `O8` O8 Bulk license actions                                                 | LX-45                                                                | partial     |
| `O9` O9 Non-admin operator                                                   | ST-29, ST-31                                                         | mockup-only |
| `P1` P1 First sign-in to activation and download                             | PX-12, PX-14, PX-21, I-37                                            | partial     |
| `P2` P2 Activate a key                                                       | PX-17 (done), PX-29                                                  | built       |
| `P3` P3 Download for my platform                                             | PX-09                                                                | partial     |
| `P4` P4 What you own and devices                                             | PX-28, LX-15                                                         | partial     |
| `P5` P5 Account                                                              | PX-13 (done), PX-22 (done), PX-31                                    | built       |
| `P6` P6 Errors and dead ends                                                 | PX-12                                                                | partial     |
| `0.7` Moments of delight                                                     | MO-11 (done), MO-07 (done), PX-24 (done)                             | built       |
| `0.9` Data behind the journeys                                               | LX-14, ST-44                                                         | partial     |
| `2` Copy rules                                                               | ST-37 (done)                                                         | built       |
| `3` Shared component inventory                                               | P0-37, P0-38, ST-07                                                  | partial     |
| `4` Page anatomy                                                             | P0-37, ST-48                                                         | partial     |
| `5.1` Console chrome                                                         | ST-48, ST-45                                                         | partial     |
| `5.2` Portal chrome                                                          | PX-27                                                                | built       |
| `6` Tables, lists, forms, settings rows                                      | ST-07, P0-37                                                         | partial     |
| `7` Confirmations, status, pills, toasts                                     | P0-37                                                                | partial     |
| `7.1` Accessibility rules                                                    | PX-26, MO-13                                                         | partial     |
| `7.2` Motion mapping                                                         | MO-02 (done), MO-04 (done), MO-08 (done), MO-09 (done), MO-11 (done) | built       |
| `8` Shared sign-in (AuthCard)                                                | I-07 (done), P0-38, PX-12, I-36                                      | partial     |
| `9` Empty, loading, error states                                             | P0-37                                                                | built       |
| `10.1` Console consolidation C1-C18                                          | ST-08, ST-44, ST-45, A-21, ST-47, ST-41                              | partial     |
| `10.2` Portal consolidation                                                  | PX-27, PX-28, PX-29, PX-31                                           | partial     |
| `11.1` Copy pass: sign-in, Worker, email                                     | I-07 (done), PX-W7 (done)                                            | built       |
| `11.2` Copy pass: portal                                                     | P0-36                                                                | partial     |
| `11.3` Copy pass: console                                                    | ST-37 (done)                                                         | built       |

### SIGN-IN (63 sections: 6 built, 35 partial, 9 mockup-only, 13 informational)

| Section                                                                       | Owners                                                                                         | In code     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| `0` Owner decisions O-1..O-18 (binding)                                       | I-08, I-09, PX-14, PX-12, P0-38, I-10a, I-10b, UK-05                                           | partial     |
| `2.2` What a sign-in flow carries (flow record, binder, chosen licence)       | I-08, I-09, PX-14                                                                              | partial     |
| `2.3` Bindings: sign-in binds installation to an anchor licence (bound_by=s…  | I-09, I-08, LX-10                                                                              | partial     |
| `2.4` Two ways to integrate: hosted card (A) and kit/headless primitives (B)  | PX-14, I-10a, I-10b, UK-05, I-36                                                               | mockup-only |
| `3` The step model (heading)                                                  | PX-12, P0-38                                                                                   | partial     |
| `3.1` The card: ui/auth/AuthCard (28.5rem, 56px app header, footer)           | P0-38, PX-12, PX-14                                                                            | partial     |
| `3.3` MethodsStep (identifier-first email, Apple/Google/Steam row, passkey)   | PX-12, PX-05 (done), I-07 (done), I-06 (done)                                                  | partial     |
| `3.4` CodeStep, HintStep, RegisterStep                                        | PX-12, PX-05 (done)                                                                            | partial     |
| `3.5` EmailGateStep (first provider sign-in) and profile import               | PX-21, PX-W15 (done), PX-W16 (done), I-07 (done)                                               | partial     |
| `3.6` LicenseChoiceStep (every app sign-in, row anatomy, create-new row)      | PX-14, I-08, I-09, LX-10                                                                       | partial     |
| `3.7` ReplaceDevice (in-card, one confirm, shared budget)                     | PX-14, I-09                                                                                    | partial     |
| `3.8` ConsentStep (Continue to <App> as <name>?)                              | PX-14, I-34, I-08                                                                              | partial     |
| `3.9` KeyStep (key entry before/after auth, entry limit, Continue without a…  | PX-17 (done), PX-W9 (done), PX-23 (done), PX-12, PX-14, UK-42, UK-43                           | partial     |
| `3.10` ReturnStep variants (<Product> is yours, Return to app)                | PX-14, I-08, I-15                                                                              | mockup-only |
| `3.11` DeviceApproval (Sign in with another device, QR + 8-char code)         | PX-15, PX-W14 (done)                                                                           | partial     |
| `3.12` ConsoleMethodsStep (Sign in to the console, operator chip, passkey)    | ST-30, P0-38                                                                                   | mockup-only |
| `3.13` Worker pages: renderAuthCard(), no eyebrow, request-handle header      | P0-38, I-07 (done), PX-14                                                                      | partial     |
| `3.14` Accessibility and motion (focus to h1, live region, reduced motion)    | PX-12, PX-20 (done), P0-38                                                                     | partial     |
| `3.15` Emails (signin.mail.\*, centred lockup, code first)                    | PX-W7 (done), I-18 (done), I-07 (done)                                                         | partial     |
| `3.16` Sign-in methods after sign-in (connect/disconnect, step-up, add-metho… | PX-13 (done), PX-15                                                                            | partial     |
| `3.17` Apps: the one sign-in form (inline/sheet/browser, desktop, mobile, Go… | I-10a, I-10b, I-15, I-37, UK-05, UK-06, UK-07, UK-08, UK-09, UK-10, UK-11, UK-12, UK-42, UK-43 | partial     |
| `3.18` Motion (step travel, height morph, list stagger, success moment)       | PX-12, UK-04, UK-05, MO-02 (done)                                                              | partial     |
| `4.1` Storyboard: Portal direct                                               | PX-12, PX-21                                                                                   | partial     |
| `4.2` Storyboard: App passthrough, device code and QR                         | I-08, I-37, UK-27                                                                              | partial     |
| `4.3` Storyboard: App passthrough, web redirect                               | I-08, I-21, PX-14                                                                              | partial     |
| `4.4` Storyboard: App passthrough, native                                     | I-15, I-08, I-10a, I-10b                                                                       | partial     |
| `4.5` Storyboard: license-key on-ramp and key-entry limit                     | PX-W9 (done), PX-17 (done), PX-23 (done), UK-42, UK-43                                         | built       |
| `4.6` Storyboard: first sign-in from a provider                               | PX-21, I-06 (done), PX-W15 (done), PX-W16 (done)                                               | partial     |
| `4.7` Storyboard: license choice 0/1/many/full/Replace                        | PX-14, I-09, LX-10, PX-20 (done)                                                               | partial     |
| `4.8` Storyboard: device approval                                             | PX-15                                                                                          | partial     |
| `4.9` Storyboard: sign-out (portal, console, app)                             | I-09, ST-30, PX-07 (done)                                                                      | partial     |
| `4.10` Storyboard: session expiry (portal toast + card, console in place)     | PX-12, ST-30                                                                                   | partial     |
| `4.11` Storyboard: console operator                                           | ST-30                                                                                          | mockup-only |
| `4.12` Storyboard: expired or used links, Identity off                        | I-07 (done), PX-W17 (done), PX-14                                                              | partial     |
| `4.14` Legacy product sign-in (I-26) licence choice page                      | I-26 (done), I-08                                                                              | built       |
| `4.15` Desktop apps (macOS, Windows, Linux, Godot, terminal)                  | I-15, I-10a, I-10b, I-37, UK-06, UK-08, UK-10, UK-11, UK-12, UK-13 (done), UK-14 (done)        | partial     |
| `4.16` The integrated web flow (one card start to finish)                     | PX-14, I-08, PX-12                                                                             | mockup-only |
| `5.2` Copy keys: signin.\* namespace in kit-copy                              | UK-02a (done), P0-36, UK-02b                                                                   | partial     |
| `6.1` Wire for planned steps (capabilities, me, consent, approve...)          | I-08, PX-14, PX-15, PX-W13 (done), PX-W14 (done)                                               | partial     |
| `6.2` Licence choice and Replace a device wire (I-04 amendment)               | I-08, I-09, I-13                                                                               | partial     |
| `6.3` Changes to planned contracts                                            | I-08, I-13, I-15, PX-14                                                                        | mockup-only |
| `6.4` Desktop: what the wire needs (loopback, /signin/return)                 | I-15                                                                                           | mockup-only |
| `6.5` The one form: wire (licenseChoice declaration, grant routes)            | I-08, I-13, I-14                                                                               | mockup-only |
| `6.6` Sign-in hints (loginHint, nameHint) - not planned                       | PX-W18 (dropped), UK-44 (dropped), DOC-14                                                      | mockup-only |
| `10.1` Drift: wp/I-07 login-card-email-gate                                   | I-07 (done)                                                                                    | built       |
| `10.2` Drift: wp/I-06 providers                                               | I-06 (done)                                                                                    | partial     |
| `10.3` Drift: wp/PX-W14 device approval                                       | PX-W14 (done)                                                                                  | built       |
| `10.4` Drift: wp/I-26 legacy licence choice copy and rows                     | I-26 (done)                                                                                    | built       |
| `10.5` Drift: main code paths (library status, LicenseCard, oidc pages, cons… | PX-12, P0-38, ST-30, I-08, UK-05, UK-07, UK-11                                                 | partial     |
| `10.6` Drift: other branches (PX-W8, UX-01..05, UK-01, PX-W17)                | PX-W8 (done), PX-W17 (done), UK-01 (done)                                                      | built       |

### SETUP (91 sections: 2 built, 14 partial, 61 mockup-only, 14 informational)

| Section                                                                           | Owners                             | In code     |
| --------------------------------------------------------------------------------- | ---------------------------------- | ----------- |
| `automation-per-storefront` Per storefront: what Polaris Key does, what needs you | A-23, A-32, A-24                   | mockup-only |
| `automation-every-other-wizard` Every other wizard: what Polaris Key does         | ST-41, A-32, ST-43, A-23           | mockup-only |
| `automation-waits` What each automated row waits for (gating work)                | A-32, A-23, A-17g (done)           | mockup-only |
| `1` The wizard pattern (ui/wizard)                                                | ST-39                              | mockup-only |
| `1.1` Anatomy (header, stepper, body, aside, footer)                              | ST-39                              | mockup-only |
| `1.2` Step kinds (nine kinds, AutoList)                                           | ST-39                              | mockup-only |
| `1.3` State: facts first, saved choices second (setup model)                      | ST-39, ST-41                       | mockup-only |
| `1.4` Prerequisites (PrereqList rows with inline fix)                             | ST-39                              | mockup-only |
| `1.5` Inline validation (blur/continue, 300ms availability)                       | ST-39, ST-43                       | mockup-only |
| `1.6` Smart defaults with SourceBadge                                             | ST-39, A-23                        | mockup-only |
| `1.7` Live verification (WaitingFor polling and backoff)                          | ST-39                              | mockup-only |
| `1.8` Deep-link steps (work in another console)                                   | ST-39, A-23                        | mockup-only |
| `1.9` Success state (verified fact, two next actions, Celebration)                | ST-39, MO-11 (done)                | mockup-only |
| `1.10` Skip and later                                                             | ST-39                              | mockup-only |
| `1.11` Permissions (disabled step with Ask a platform admin)                      | ST-39, ST-29                       | mockup-only |
| `1.12` Phones and accessibility of wizards                                        | ST-39, P0-40                       | mockup-only |
| `1.13` Copy rules for wizards                                                     | ST-39, ST-37 (done)                | mockup-only |
| `1.14` Components added to ui/ (Wizard, Stepper, PrereqList, SnippetStep...)      | ST-39, P0-37                       | mockup-only |
| `2` Storefronts: one catalogue, one page per storefront (now channels)            | A-19, A-20, A-21, A-22, A-23, A-24 | partial     |
| `2.1` The model (storefront=channel, amended)                                     | A-19, A-21, A-22                   | partial     |
| `2.2` Navigation after the change (Distribution to four items)                    | A-21                               | mockup-only |
| `2.3` The catalogue declaration (CatalogueEntry, auto/human lists)                | A-19                               | mockup-only |
| `2.4` Scoping (productPlatforms, planned platforms, intendedPlatforms)            | A-20                               | mockup-only |
| `2.5` Artifact fit                                                                | A-20                               | partial     |
| `2.6` The storefront state machine                                                | A-20                               | mockup-only |
| `2.7` The catalogue page                                                          | A-21, A-22                         | partial     |
| `2.8` The storefront page (state-driven)                                          | A-22, A-23                         | partial     |
| `2.8.1` Not set up or setting up: the wizard                                      | A-23, ST-39                        | mockup-only |
| `2.8.2` Live: the status page                                                     | A-22                               | mockup-only |
| `2.9` What each storefront's wizard and status page say                           | A-23, A-22                         | mockup-only |
| `2.10` Polaris Key, the built-in storefront page                                  | PS-06 (done), A-21, A-22           | partial     |
| `2.11` Publish everywhere dialog                                                  | A-24                               | mockup-only |
| `2.12` Credentials: one home each                                                 | ST-12, A-23                        | partial     |
| `2.13` Empty and error states on storefront surfaces                              | A-22, ST-38                        | partial     |
| `2.15` The read model the console needs                                           | A-20                               | mockup-only |
| `3` Connect your app: the SDK wizard (now the Integration page)                   | ST-41, ST-40, SP-33a               | mockup-only |
| `3.1` Where it lives (route, nav item, palette, launch-path step)                 | ST-41, ST-45                       | mockup-only |
| `3.2` Steps (Your app, add the SDK, run the app)                                  | ST-41, ST-40                       | mockup-only |
| `3.3` Install (D17): feed-first snippets                                          | F-12 (done), ST-41                 | partial     |
| `3.4` Configure: renderSdkSetup generator, one file per language                  | SP-33a, ST-41                      | partial     |
| `3.5` Drop-in UI (generated config module, no publishableKey)                     | ST-41, UK-05                       | mockup-only |
| `3.6` Verify (SDK sightings)                                                      | ST-40                              | mockup-only |
| `3.7` Release keys section in Keys & secrets                                      | ST-41, ST-40                       | mockup-only |
| `4` Per-service setup and every page's empty state                                | ST-38, ST-41, A-32                 | partial     |
| `4.1` Rules for every page (service-off preview, snippets)                        | ST-38                              | mockup-only |
| `4.3` Publish from CI (two steps + AutoList)                                      | A-32                               | mockup-only |
| `4.4` Update feed, scoped (collapsed until a release)                             | ST-41                              | mockup-only |
| `4.5` Customer sign-in setup wizard                                               | ST-41, ST-14, ST-12, I-31          | mockup-only |
| `4.6` Platform ready checklist                                                    | ST-44, ST-09                       | mockup-only |
| `4.7` Every console page: empty state and setup entry                             | ST-38, ST-44                       | partial     |
| `5` The launch path links into all of it                                          | ST-41                              | partial     |
| `5.1` The first screen of a new product (goals, platforms; D20)                   | ST-43, ST-41                       | mockup-only |
| `5.2` The launch path's steps and where each opens                                | ST-41                              | partial     |
| `5.3` One model, every surface (setup read)                                       | ST-41, ST-39                       | mockup-only |
| `7` Worker and API needs (W1-W21)                                                 | A-20, ST-39, ST-40, A-32, ST-44    | mockup-only |
| `UX-50` Wizard kit (backlog id UX-50)                                             | ST-39                              | mockup-only |
| `UX-51` Setup state (setup_state table, routes, consent) (backlog id UX-51)       | ST-39                              | mockup-only |
| `UX-52` Storefront catalogue declaration (backlog id UX-52)                       | A-19                               | mockup-only |
| `UX-53` Storefronts read model (backlog id UX-53)                                 | A-20                               | mockup-only |
| `UX-54` Catalogue page and storefront page shell (backlog id UX-54)               | A-21                               | mockup-only |
| `UX-55` Storefront wizard steps (human only) (backlog id UX-55)                   | A-23                               | mockup-only |
| `UX-56` Outlet block generator, pkey storefront add/sync (backlog id UX-56)       | A-25                               | mockup-only |
| `UX-57` Storefront status pages (backlog id UX-57)                                | A-22                               | mockup-only |
| `UX-58` Publish everywhere (backlog id UX-58)                                     | A-24                               | mockup-only |
| `UX-59` SDK quick-start correctness (backlog id UX-59)                            | —                                  | built       |
| `UX-60` Shared SDK setup generator renderSdkSetup (backlog id UX-60)              | SP-33a                             | mockup-only |
| `UX-61` Connect your app page (backlog id UX-61)                                  | ST-41                              | mockup-only |
| `UX-62` Publish from CI drawer (backlog id UX-62)                                 | A-32                               | mockup-only |
| `UX-63` License and Config quick starts (backlog id UX-63)                        | ST-41                              | mockup-only |
| `UX-64` Update feed and Access (scoped) (backlog id UX-64)                        | ST-41                              | mockup-only |
| `UX-65` Customer sign-in wizard (backlog id UX-65)                                | ST-41                              | mockup-only |
| `UX-66` Empty-state and service-off sweep (backlog id UX-66)                      | ST-38                              | mockup-only |
| `UX-67` Platform ready (backlog id UX-67)                                         | ST-44                              | mockup-only |
| `UX-68` Setup runner (backlog id UX-68)                                           | A-23                               | mockup-only |
| `UX-69` Live credential check (backlog id UX-69)                                  | —                                  | built       |
| `UX-70` GitHub write path (backlog id UX-70)                                      | A-32                               | mockup-only |
| `UX-71` CI installation-token exchange (backlog id UX-71)                         | A-32                               | mockup-only |

### FLOWS (48 sections: 6 built, 14 partial, 16 mockup-only, 12 informational)

| Section                                                                                     | Owners                                                               | In code     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------- |
| `1.1-new-product` Console flows: New product, Welcome, Home first run, Overview checkli…    | ST-43, ST-41, ST-39                                                  | partial     |
| `1.1-product-config` Console flows: Services, keys, secrets, resync, link repo, devices, p… | P0-37, ST-45, A-32, LX-14                                            | partial     |
| `1.1-console-signin` Console sign-in, signed out, session ended                             | ST-30, P0-38                                                         | mockup-only |
| `1.1-licensing` Console licensing flows (New license, grants, tiers, catalog, profile…      | LX-29, LX-14, LX-13, P0-37, ST-12                                    | partial     |
| `1.1-identity-release` Console identity, portal settings, releases, rollouts                | ST-41, ST-14, A-32, A-24                                             | partial     |
| `1.1-distribution` Console distribution: App Store, commerce, outlets, feeds, store conn…   | A-23, A-22, A-24, A-21, F-34, ST-44                                  | partial     |
| `1.1-platform` Console platform settings, deployment, update feed, products row menu        | ST-07, ST-16, ST-09, ST-41                                           | partial     |
| `1.2-branches` Flows only on in-flight branches (Add to storefronts, step dialogs, p…       | A-21, A-23, A-18j (done), I-12 (done), LX-14a (done)                 | built       |
| `1.3-portal-signin` Portal and Worker sign-in flows (card, Worker pages, device code, lic…  | PX-12, P0-38, PX-21, I-07 (done), PX-14                              | partial     |
| `1.3-portal-account` Portal flows: Activate, Free a device, Remove device, Download, Packa… | PX-17 (done), PX-23 (done), PX-10 (done), PX-22 (done), PX-13 (done) | built       |
| `1.3-portal-identity` Portal flows: linked methods, library empty, Discover, jump, approve… | PX-13 (done), PX-15, PX-14, PX-21, PX-16 (done)                      | partial     |
| `2` Rules every flow follows (C1-C18, P rules)                                              | ST-39, P0-40, P0-37                                                  | partial     |
| `2.1` Shape rules (C1-C5: host by job, five steps, focus, Escape)                           | ST-39, P0-40                                                         | partial     |
| `2.2` Input rules (C6-C9: ask only what has no source)                                      | ST-39, ST-43                                                         | mockup-only |
| `2.3` Outcome rules (C10-C16: waits visible, announcements, results)                        | ST-39, P0-40                                                         | partial     |
| `2.4` Feel rules (C17-C18: motion vocabulary, reduced motion)                               | ST-39, MO-11 (done)                                                  | partial     |
| `3` New Product, redesigned (heading)                                                       | ST-43                                                                | partial     |
| `3.2` The redesign in one paragraph (page-hosted wizard at #/products/new)                  | ST-43, ST-39                                                         | mockup-only |
| `3.3` Storyboard of New Product                                                             | ST-43                                                                | mockup-only |
| `3.4` The steps (Where it starts, Check, Name it, What it's for, Creating)                  | ST-43, ST-39                                                         | mockup-only |
| `3.5` What Polaris Key does, what it asks (create with defaults)                            | ST-42, ST-43                                                         | mockup-only |
| `3.6` The ready moment and hand-off (hero, once)                                            | ST-41, ST-43                                                         | mockup-only |
| `3.7` States (no app installed, no manifest, problems...)                                   | ST-43                                                                | mockup-only |
| `3.8` Motion (shared-element tile, check, burst)                                            | ST-39, ST-43                                                         | mockup-only |
| `3.9` Accessibility (stepper list, radio group, listbox)                                    | ST-43, P0-40                                                         | mockup-only |
| `3.11` Worker needs W22-W26                                                                 | ST-43, ST-42, ST-41                                                  | partial     |
| `UX-72` Create probes (W22-W24) (UX-72)                                                     | —                                                                    | built       |
| `UX-73` Create with defaults (W25) (UX-73)                                                  | ST-43, ST-42                                                         | mockup-only |
| `UX-74` New Product wizard (UX-74)                                                          | ST-43                                                                | mockup-only |
| `UX-75` Ready moment and hand-off (UX-75)                                                   | ST-41                                                                | mockup-only |
| `UX-76` Presentation in create (derived accent, swatches) (UX-76)                           | ST-43                                                                | mockup-only |
| `UX-77` Console flow conformance (UX-77)                                                    | —                                                                    | built       |
| `UX-78` One resync flow (UX-78)                                                             | —                                                                    | built       |
| `UX-79` Portal flow conformance (UX-79)                                                     | —                                                                    | built       |
| `UX-80` Flow motion (step travel, AutoList draw, burst) (UX-80)                             | ST-39                                                                | mockup-only |
| `UX-81` Flow lint (UX-81)                                                                   | P0-40                                                                | mockup-only |

## 11. Brand-transition changes (372)

Each of the 372 audit entries (`_brand/sections/*/changes.json`) is in the JSON with its resolution and owner. Summary:

| Source   | Changes | Applied to docs only | Applied to a WP | Merged | Deferred | Dropped | Record only | Owner todo | Owner done |
| -------- | ------- | -------------------- | --------------- | ------ | -------- | ------- | ----------- | ---------- | ---------- |
| admin-1  | 36      | 18                   | 9               | 0      | 0        | 0       | 0           | 31         | 0          |
| admin-2  | 31      | 17                   | 6               | 0      | 0        | 0       | 0           | 26         | 0          |
| admin-3  | 30      | 15                   | 4               | 0      | 0        | 0       | 0           | 16         | 0          |
| admin-4  | 24      | 9                    | 6               | 0      | 0        | 0       | 0           | 16         | 0          |
| auth     | 23      | 15                   | 4               | 0      | 0        | 0       | 0           | 14         | 0          |
| brand    | 42      | 18                   | 9               | 0      | 0        | 0       | 0           | 28         | 0          |
| overview | 28      | 14                   | 4               | 0      | 0        | 0       | 0           | 18         | 0          |
| portal   | 31      | 12                   | 16              | 0      | 0        | 0       | 0           | 21         | 1          |
| sdk-a    | 33      | 12                   | 11              | 0      | 0        | 0       | 0           | 20         | 0          |
| sdk-b    | 27      | 12                   | 8               | 0      | 0        | 0       | 0           | 17         | 0          |
| sdk-c    | 32      | 14                   | 13              | 0      | 0        | 0       | 0           | 22         | 2          |
| site     | 35      | 10                   | 6               | 0      | 0        | 0       | 0           | 16         | 0          |
