# Locker UX adoption: execution map (2026-10-19)

Source: `integ/next` @ 4159537f0. Coverage = `ux-coverage.json`. Customer filter: 209 gaps (128 partial,
81 mockup-only). Admin filter: 366 gaps. Statuses come from `workpackages.json`, corrected by the lead's
in-flight list. Tiers follow the owner's order: **P1** Locker auth → **P2** Locker UI-only → **P3** Key
surfaces → **P4** Locker work that needs a backend package.

**Global rules for every builder**

- Build to the latest mockup (`docs/design/mockups/screens/{portal,identity}/*`, `experience/*.png`) with the
  Locker identity: `data-brand="locker"`, the Locker lockup, polaris.locker, coral used only for identity
  (BRAND §15, D9a), and a neutral ink primary.
- The mockups still draw Key (see §5). Builders follow §5, not the pixels.
- One `pkey-ux-reviewer` per package, in BUILT mode, at the end. Mockup-only packages get one MOCKUP pass instead.
- The cap is ≤8 concurrent builders, in-flight work included. Each wave lists its _new_ builders; start
  them as in-flight slots free up.

**In flight (placed, not re-planned):** LK-04 (bind hop, device page), LK-06 (portal and card shell),
LK-07 (Worker pages and all mail), LK-08a (kit copy), LK-10 (console links), P0-38 + PX-12 (AuthCard, card
v2), PX-29 (focused frame), P0-36 (portal copy catalog). LK-17 is done; LK-14 is in review.

**File-ownership conflicts to avoid now**
| Files | Held by | Rule |
|---|---|---|
| `admin/src/portal/**` (shell, `Lockup`, `PortalShell`, account/_, product/{LicenseCard,SectionNav}, `copy/_`, `index.html`, `vite.config.ts`) | LK-06, P0-36 | No new portal SPA builder until both merge |
| `admin/src/ui/auth/**`, `portal/components/signin/*`, `pages/SignInPage.tsx`| P0-38, PX-12 | Card steps wait for them |
|`worker/src/core/{brandHtml,brandPage,pageBrand,securityHeaders}.ts`, `core/notify/*`, `distribution/page/\*` | LK-07 | **P0-38's Worker twin `renderAuthCard()` lives in `brandHtml.ts`: merge LK-07 first, then rebase P0-38\*\* |
| `identity/productOidc/{deviceFlow,pages}.ts`, `passthrough/{authorize,request}.ts`, `dispatch.ts` | LK-04 | Worker sign-in pages wait for LK-04 |
| `pages/{FreeDevicePage,DownloadFlowPage}.tsx`, `FocusedFlow.tsx`, `ActivateDialog.tsx` | PX-29 | |

## 1. P1: Locker auth surfaces

| Surface                                                                            | Mockup / spec                                                    | Built   | Owner                                     | Open blockers                       | Verdict                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- | ----------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Card frame, MethodsStep (email first, Apple/Google/Steam row, passkey through ROR) | portal.signin, identity.sign-in; SIGN-IN §3.1, §3.3              | partial | P0-38, PX-12 (in flight)                  | none (I-07, I-06, I-16, LK-05 done) | UI-first now (in flight)                                                                                |
| CodeStep, HintStep (usual method), RegisterStep; session expiry                    | SIGN-IN §3.4, §4.10                                              | partial | PX-12                                     | none                                | UI-first now (in flight)                                                                                |
| Key on-ramp, AccountUpgrade (portal)                                               | identity.key-step; SIGN-IN §3.9, §4.5                            | partial | PX-12                                     | none (PX-W9 done)                   | UI-first now (in flight)                                                                                |
| FinishStep: email gate, profile import, terms                                      | identity.finish; SIGN-IN §3.5, §4.6                              | partial | PX-21                                     | PX-12, P0-38                        | UI-first (W2). Backend is done (PX-W15, PX-W16, I-33). Must ship with the providers                     |
| App card header (app and device variants), passport pane ≥960 landscape (React)    | identity.sign-in (app), hosted:app-header-passport; SIGN-IN §3.1 | mockup  | PX-14 → **PX-14a**                        | PX-12; brief also lists I-15, I-37  | UI-first (W2) on I-08's `SignInRequestView`. **Drop the I-15/I-37 deps for 14a**                        |
| LicenseChoiceStep, ReplaceDevice (0/1/many/full/Replace)                           | identity.refusals; SIGN-IN §3.6, §3.7, §4.7                      | partial | PX-14a                                    | PX-12                               | UI-first (W2). I-08 and I-09 are done; the server orders the rows (LX-10 is not needed)                 |
| ConsentStep "Continue to <App> as <name>?"                                         | identity.consent; SIGN-IN §3.8                                   | partial | PX-14a                                    | PX-12                               | UI-first (W2): chosen licence + Change + equal Allow/Deny. **Per-claim toggles hidden** until I-34 (P4) |
| KeyStep in the card, ReturnStep (web), integrated web flow                         | SIGN-IN §3.9, §3.10, §4.16                                       | mockup  | PX-14a                                    | PX-12                               | UI-first (W2). Native return variants → P4 (I-15)                                                       |
| Device code `/device` `/tv`: entry, wrong/expired/too many                         | identity.device-code(-states); SIGN-IN §3.13, §4.2               | partial | LK-04 (host and index), **I-38a** (look)  | LK-04, LK-07, P0-38                 | UI-first (W2): Worker page on `renderAuthCard()`, code and QR side by side in landscape                 |
| "Sign in on <device>?" confirm with Deny; per-product device page 303              | identity.device-confirm, auth-12; LK-00 §7.9                     | partial | I-38a (UI step), LK-04 (303)              | as above                            | UI-first (W2): the explicit confirm step is presentation only. The fail-closed marker is I-37 (P4)      |
| Refusal cards (device limit, all full, other email, key entries used up)           | identity.refusals, auth-08; DL6                                  | partial | I-38a                                     | LK-07, P0-38                        | UI-first (W2): DL6 neutral callout, the fix as the one primary, no disabled dead end                    |
| Magic-link landing, expired or used link, identity off, "you're signed in"         | SIGN-IN §3.13, §4.12                                             | partial | LK-07 (identity), I-38a (layout)          | LK-07                               | UI-first (W2). Backend done (I-07, PX-W17)                                                              |
| Hosted passport + CSP `img-src` image origin                                       | auth-01, auth-14, hosted:csp-img-src-branded                     | mockup  | I-38a                                     | LK-07 (`securityHeaders.ts`)        | UI-first (W2). One-origin guard, as the app policy                                                      |
| Sign in with another device (new side) + Approve a new device (Account)            | SIGN-IN §3.11, §4.8; PORTAL §4.6                                 | mockup  | PX-15                                     | PX-12, P0-38                        | UI-first (W2). Backend done (PX-W14, `portal/deviceLogin.ts`)                                           |
| Add-method nudge, link accounts, methods after sign-in                             | SIGN-IN §3.16                                                    | partial | PX-15                                     | PX-12                               | UI-first (W2). Backend done (PX-W12)                                                                    |
| Sign-in emails (code, magic link, confirm email)                                   | SIGN-IN §3.15                                                    | partial | LK-07 (sender, lockup), I-39 → **LK-07b** | LK-07                               | UI-first (W2): ink button, neutral callouts, centred Locker lockup, HTML snapshots                      |
| Sign-out                                                                           | SIGN-IN §4.9                                                     | partial | done (I-09, PX-07)                        | none                                | Verify only, in PX-12's review                                                                          |

**P1 waves**

- **P1-W1 (start now, 2 new; no code conflicts)**
  - **MK-L1 Locker auth mockups** (new, docs only). Re-skin `identity.{sign-in,device-code,device-code-states,device-confirm,consent,finish,key-step,refusals}.html` and `portal.signin.html` to Locker. Apply the §5 wording fixes to SIGN-IN.md. Base: integ/next. One MOCKUP review. Do it first: BUILT reviews compare against these files.
  - **I-37 plan** (pkey-wire-planner, plan mode). The fail-closed device-code marker only. **Lead decision: cut I-37's dep on I-15.** The marker is Worker-side, and I-15 sits behind I-10a/b → SP-35/35b → HA-13. Base: integ/next. No review.
- **P1-W2 (after LK-06, LK-07, LK-04, P0-38 and PX-12 merge; base integ/next post-merge; 4 new)**
  - **PX-12b = PX-21 folded into PX-12's builder**: EmailGate and ProfileImport in every variant, with the app header kept. This keeps "providers ship with the gate" a single release.
  - **PX-14a**: CardHeader, LicenseChoice, Replace, Consent (no toggles), KeyStep confirm, web ReturnStep, the §4.16 integrated flow, motion (§3.18) and the React passport ≥960. Owns `ui/auth/steps/{License,Consent,Return}*` and hosts PX-12b's step.
  - **PX-15**: DeviceApproval, a new step file plus the Account approve dialog, AddMethodNudge and LinkAccounts. Leave SignInPage routing to PX-14a and add one route entry only.
  - **I-38a = I-38 plus PX-14's Worker-page half plus auth-12**: the `/device` and `/tv` look and states, the device confirm, DL6 refusals, magic-link and identity-off cards, the passport, CSP `img-src` and a static expiry. **Drop the I-37 dep.** Owns `brandHtml.ts` and `productOidc/pages.ts` after LK-07 and LK-04.
  - **LK-07b = I-39 folded onto LK-07's rewritten `templates.ts`**: every customer email (sign-in, notices, licence key, download link) with the ink button, neutral callouts and HTML snapshots. Drop the I-39 → I-38 dep. It starts the moment LK-07 merges and does not need P0-38.
- **P1 left for P4:** I-37 marker, I-15 native returns, I-34 consent toggles, I-13/I-14 store sign-in, PX-33 (parked).

## 2. P2: Locker surfaces with no Polaris Key change

Every item below is client-side and copy only, on today's `/api/*`, with no new route, field or migration.

| Surface                                                                                         | Mockup / spec                                                            | Built   | Owner                              | Evidence of no backend change                                                                                                                            | Shown now / hidden until                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Library (1, 2–7, 12, empty): Q2 masthead, calmer attention shelf, empty state + Discover teaser | portal.library, -12, -empty; portal-14, portal-17                        | partial | **PX-34 (new)**                    | `GET /api/library` (PX-08 done) has art, seats, quick actions and the discover count; PX-27 done                                                         | Show everything except the duration line and add-ons (LX-15, P4) and "added automatically" (LX-38, P4) |
| Discover: 3-column grid, no "What shows up here", open/trial/store-only labels                  | portal.discover; portal-23 (PS-11)                                       | partial | PX-34                              | `model/discover.ts` already maps `open`/`trial`/store reasons (PX-W10 done)                                                                              | Visibility per product setting → PS-12 (P4)                                                            |
| Storefront product decision panel                                                               | portal.discover-detail; portal-19                                        | partial | **PX-32a**                         | `core/storefront/polarisKeyListing.ts` listing (developer, platforms, tier) served by `storefrontListing.ts`                                             | Downloads/listing entries → PS-05b; duration → LX-41 (both P4)                                         |
| Product page (Get it, What's new, License, Devices, Packages pointer, Help)                     | 09-portal-product; PORTAL §4.4                                           | partial | LK-06 (identity), PX-28a           | Sections exist (PX-04, PX-08)                                                                                                                            | Full channel actions → PX-09 / A-26; Cloud Sync → PX-18 / U-05 (both P4)                               |
| License page v2: term timeline, one downloads table, Renew only in the License card             | portal.license, portal.license-lapsed; portal-07                         | partial | **PX-28a** (split of PX-28)        | `expiresAt` and the covered-version field are already in `portal/api.ts` and `model/product.ts`; SHA-256 is already in the download data (PX-29 uses it) | Duration, subscription and add-ons lines → LX-15 / LX-41; channel picker → P2-13 / A-26 (P4)           |
| Focused free-device, download, Activate (enter, confirm, done, errors)                          | portal.free-device, .download, .activate(-confirm); portal-06, portal-15 | partial | PX-29 (in flight)                  | PX-29 brief: "No wire change"                                                                                                                            | Activate auto-add → LX-38 (P4)                                                                         |
| Account v3: canonical nav, masthead, Profile identity row, methods, sessions, Your data, delete | portal.account; portal-18                                                | partial | **PX-31a** (split of PX-31)        | PX-13, PX-22, PX-W19 and PX-07 are done; the page omits sections with no API (PORTAL §4.6)                                                               | Packages when F-33 merges (in review); Connected apps → I-34 (P4)                                      |
| Customer non-auth mail (notices, licence-key email "Open in Polaris Locker", download link)     | SIGN-IN §3.15; LK-00 §7.11                                               | partial | LK-07, LK-07b                      | Template-only change                                                                                                                                     | Nothing hidden                                                                                         |
| Download page on dl.plrs.im (Locker shell, Star Cut inside)                                     | LK-00 §14.2                                                              | partial | LK-07 (in flight)                  | Render only                                                                                                                                              | Badge link → LK-12 (P4, after LK-11)                                                                   |
| Help door words and host                                                                        | LK-00 §2.1                                                               | partial | LK-09 (worktree open)              | Docs only                                                                                                                                                | none                                                                                                   |
| SDK kit copy + "Powered by Polaris Locker"                                                      | LK-00 §2.1, §14.2                                                        | partial | LK-08a (in flight) → LK-08b, LK-16 | Generated copy and marks; no wire                                                                                                                        | none                                                                                                   |
| Portal motion strips                                                                            | portal-24                                                                | mockup  | MO-13 (in progress)                | QA only                                                                                                                                                  | none                                                                                                   |

**P2 waves**

- **P2-W1 (start now, 1 new):** **MK-L2 Locker portal mockups** (docs only). Re-skin the 13 `portal.*.html` files: lockup, `aria-label`, footer host line removed, polaris.locker. Base: integ/next. One MOCKUP review. It can share a builder with MK-L1.
- **P2-W2 (after LK-06 and P0-36 merge; base integ/next; ≤5 new):**
  - **PX-34**: Library and Discover to the mockups. Owns `Library*`, `Discover*`, `AttentionShelf`, `pages/{Library,Discover}Page`.
  - **PX-28a**: License page v2 on today's data. Owns `product/LicenseCard.tsx` plus a new timeline file.
  - **PX-31a**: Account v3 shell. Owns `pages/AccountPage.tsx` and `components/account/*` except files PX-15 adds.
  - **PX-32a**: storefront decision panel. Owns `pages/StorefrontPage.tsx`.
  - **LK-08b and LK-16**: one sdk-porter after LK-08a merges.
  - Order: PX-31a after PX-15, or agree that PX-15 only adds files under `account/`.

## 3. P3: Polaris Key surfaces (console, dev docs, CLI, operator)

The Key side stays Key-branded; only words about the customer site say Locker (A4). There are 366 gaps:
SETUP 75, admin-1..4 89, commerce 29, config 23, identity 21, packages 20, overview 18, site 17, ADMIN 17,
admin 13, licenses 13, products 12, docs 11, distribution 8. **70 gaps have only done owners**: run one
`check.mjs` coverage reconcile (lead, no builder) before dispatching any of them.

| Group (gaps)                                                 | Packages: state                                                | Open blockers                                             | Verdict                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| Console identity + words (LK)                                | LK-14 in review, LK-10 in flight, LK-15 todo                   | none                                                      | In flight; LK-15 now                                  |
| Console sign-in (SIGN-IN §3.12, §4.11; FLOWS C-16)           | ST-30 todo → ST-31 → ST-32 → ST-35; ST-34                      | P0-38                                                     | UI-first after P0-38 (AuthCard ConsoleMethodsStep)    |
| Shell and IA (≈90: EXPERIENCE §0.2, §4, §5.1, admin-1..4)    | ST-45 → ST-48 → ST-49, ST-51; UK-63                            | ST-08 (in progress)                                       | UI-first after ST-08                                  |
| Home and attention (overview 18)                             | ST-44 → ST-47                                                  | none                                                      | **Now** (watch LK-10 and LK-14 on Home/Overview copy) |
| Settings (O4, S4)                                            | ST-08 in progress → ST-10, ST-12, ST-14; ST-11                 | ST-08                                                     | ST-11 now; the rest after ST-08                       |
| Identity console (identity 21, auth-03/06/16)                | I-29 → I-36; I-32 and I-35 gated                               | none for I-29                                             | **I-29 now**                                          |
| Setup / launch path (SETUP 75)                               | ST-41, ST-39 done (residual); A-20..A-24, A-32                 | A-19 (in progress)                                        | Reconcile first; A-20 after A-19                      |
| Distribution and channels (distribution 8, C-43..52)         | A-20 → A-28, A-22 → A-21, A-23, A-24, A-33; P2-11; A-25 → A-32 | A-19                                                      | Backend chain                                         |
| Packages (packages 20)                                       | F-33 in review → F-34 → F-35, F-37, F-38                       | F-33                                                      | After F-33                                            |
| Licensing console (licenses 13, entitlements 12, O1, O8, S3) | LX-14, LX-44, LX-43, LX-45, P2-10, P4-34                       | LX-33 → LX-34 → LX-35 → LX-36 train (P0-49), LX-41 (plan) | Needs backend first (licensing train)                 |
| Commerce (commerce 29)                                       | CM-21, CM-22, CM-23, CM-24, CM-25, CM-28                       | LX-11, LX-35, A-28, P0-49                                 | Needs backend first                                   |
| Config (config 23)                                           | U-27 → U-28 → U-29; U-32                                       | P0-49, LX-34, U-06                                        | Needs backend first                                   |
| Shared components and tests                                  | P0-37 (P0-34 → P0-39), P0-40 (P0-33)                           | P0-34, P0-33                                              | After the P0 foundations                              |
| Docs site (site 17, docs 11)                                 | DOC-02a → DOC-02b, DOC-02c, DOC-13; DOC-03b; DOC-12a; UK-62    | LK-15 (chrome)                                            | DOC-03b and DOC-12a now; DOC-02a after LK-15          |
| Design lints                                                 | UK-55, UK-59                                                   | none                                                      | Now (low priority)                                    |

**P3 waves (after P1-W2 and P2-W2 take their slots)**

- **P3-W1 (now; ≤6):**
  - ST-44
  - I-29
  - ST-11
  - DOC-03b
  - DOC-12a
  - LK-15
  - A-20 (the moment A-19 lands)
  - Bases: integ/next.
  - Conflicts: ST-44 vs LK-10 and LK-14 on console Home and Overview, so merge LK-10 first. I-29 vs LK-04 on `identity/routes.ts`, so I-29 adds one route row only.
- **P3-W2 (after ST-08, P0-38, F-33 and LK-15; ≤8):**
  - ST-45
  - ST-30
  - ST-10, ST-12, ST-14 (one builder, settings hub)
  - A-28
  - F-34
  - DOC-02a
  - I-36 (after I-29)
- **P3-W3:**
  - ST-48 → ST-49, ST-51
  - ST-31
  - A-22 → A-21, A-23, A-24
  - F-35, F-37, F-38
  - P2-11
  - UK-63
  - ST-47
- **P3-gated:** licensing, commerce and config trains (above). Unblock order: P0-49 → LX-33 → LX-34 → LX-35 → LX-36. Run the LX-41 plan now (planner).

## 4. P4: Locker surfaces that need a Key/backend change

| Surface (mockup)                                                                                                                            | UI package                       | Backend package that unblocks it, and why                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Device code fail-closed (R1-07/R8-03)                                                                                                       | I-38a ships the confirm UI first | **I-37** (plan mode): the server capability marker. Today it waits on I-15; cut that dep (P1-W1)                  |
| Native ReturnStep: loopback, claimed HTTPS, registered scheme (SIGN-IN §3.10, §4.4, §6.4)                                                   | PX-14b                           | **I-15** ← I-10a/b ← SP-35/35b ← HA-13 (in review): the wire for the desktop return does not exist yet            |
| Consent toggles per claim; Account → Connected apps; disconnect (identity.consent, identity.connected-apps, identity.disconnect, portal-12) | PX-14b, PX-31b                   | **I-34** ← I-35 ← LX-36 ← LX-35 ← LX-34 ← LX-33 ← P0-49: there are no `identity.claims` and no connected-apps API |
| Store and game sign-in rows                                                                                                                 | PX-12 follow-up                  | **I-13, I-14**: no token exchange for store kinds                                                                 |
| Library and License duration line, add-ons, Automatic grant, subscription/renew (portal-10, license-lapsed states)                          | **PX-28b = LX-15 + PX-28 rest**  | **LX-41** (plan mode), **LX-09**, **LX-10**: duration, subscription state and composition are not in the API      |
| "Added automatically", Discover for every account, Activate auto-add                                                                        | PX-34 / PX-29 follow-up          | **LX-38** ← LX-36: account-keyed automatic licences do not exist                                                  |
| Licences in an account need sign-in                                                                                                         | —                                | **LX-39** ← I-10a/b                                                                                               |
| Get it: every channel action; channel picker + SHA rows on the product page (PX-09, P2-13, portal-13)                                       | PX-09, P2-13                     | **A-26** ← A-19 (in progress), A-20: no customer channel actions in the API                                       |
| Storefront panel downloads and listing entries; Discover visibility                                                                         | PX-32b                           | **PS-05b** ← A-26; **PS-12** ← LX-36                                                                              |
| Product page Cloud Sync section                                                                                                             | PX-18                            | **U-05** (plan mode, ← P0-25) and **U-12**: there is no Cloud Sync data source (PORTAL §4.4)                      |
| Badges in use at `polaris.locker/<slug>` and the download-page badge link                                                                   | LK-12                            | **LK-11** cutover deploy, plus owner steps O5, O6, O8, O9 and O10                                                 |
| Requesting product's cover beside the card (portal-22)                                                                                      | PX-33                            | Parked by the owner (B12); start only if the owner asks                                                           |

## 5. Mockup and spec content that contradicts the owner rules (builders ignore it)

1. **All 13 `portal.*.html`**: the Key lockup, the footer "Polaris Key · key.plrs.im" and the nav `aria-label="Portal"`. Use the Locker lockup and no host line (SIGN-IN §3.1 already bans it). Name the nav for the place, not "Portal".
2. **`portal.signin.html`** h1 "Sign in to Polaris Key" → "Sign in to Polaris Locker" (SIGN-IN §3.3 already says Locker).
3. **Trust receipt** "Polaris Key signs you in for <App>…" in identity.{sign-in,device-code,device-code-states,device-confirm,consent,finish} and SIGN-IN.md L207/L227 → "Polaris Locker signs you in for <App>…".
4. **identity.device-code** "key.plrs.im/device" → `polaris.locker/device` (`verificationUri`, LK-04).
5. **identity.finish** and SIGN-IN §3.5 (L366, L376): "I agree to Polaris Key's Terms…", "Shown in Polaris Key and in emails" → Locker. _The lead/owner confirms the terms document's name._
6. **"Can't reach Polaris Key"** at SIGN-IN L25, L311 and L502 (customer card) → "Can't reach Polaris Locker" (A3 D8). L683 is the console and stays Key.
7. **Switch and timing language**: SIGN-IN L25 "reaches customers when `customer.host` turns on", any "once the switch is on" or 14-day soak → withdrawn (A5). `CUSTOMER_ORIGIN` set = Locker, and old URLs 301.
8. **Emails**: SIGN-IN L337, L745 and L751 "Your Polaris Key code", "says Polaris Key" → "Your Polaris Locker code", sender "Polaris Locker" / "<App> via Polaris Locker" (LK-00 §7.11). PX-W7's "Polaris Key sender" is superseded. Operator and member mail stays Key (A4).
9. **Key verdict** SIGN-IN L604 "That isn't a Polaris Key license key. Ours start with pkey\_." → "Polaris Locker license key". The `pkey_` prefix stays (rule 8).
10. **Kit and device copy**: SIGN-IN L662 "Nobody from Polaris Key…", L851 "We opened Polaris Key in your browser", L931 "safe in Polaris Key" → Locker (LK-08a owns the kit copy).
11. **"Portal" or "customer portal"** in customer copy (SIGN-IN L543, L557; identity.sign-in-off and app-sign-in "Customer portal" are console screens) → "Polaris Locker". "portal" stays only in identifiers and internal docs.
12. **Passthrough brand row**: "Polaris Key's lockup shrinks to a quiet brand row" (SIGN-IN L86) → the Locker compact lockup (≥120 px wide) or the micro mark below 24 px. Never the Key mark on a customer surface.
13. **Colour**: violet primary (auth-02, old PORTAL "solid violet") and the violet `--pk-focus` ring (auth-21) → neutral ink primary and a `--pk-text-strong` focus ring. Coral never marks a state, a primary or a selected fill (D9a, LK-06 `locker.css`).
14. **Kit attribution** drawn as "Powered by Polaris Key" or the Pinned K → "Powered by Polaris Locker" with the Locker micro mark (LK-16). The kit look stays host-owned: no coral, no Locker mark outside the attribution.
15. **Ignore** sign-in hints (SIGN-IN §6.6, PX-W18 and UK-44 dropped) and the star field's Key colours. If LK-06's Locker shell keeps the star field, keep it neutral, with no Key violet or gold.

## 6. Proposed graph edits (lead applies them with check.mjs)

- Split: PX-14 → 14a/14b, PX-28 → 28a/28b (28b absorbs LX-15's portal UI), PX-31 → 31a/31b, PX-32 → 32a/32b, I-38 → I-38a (scope widened, I-37 dep dropped).
- Fold: PX-21 into PX-12 (PX-12b); I-39 into LK-07b.
- New: MK-L1 and MK-L2 (Locker mockup re-skins, docs), PX-34 (Library and Discover adoption).
- Dep cuts: PX-14a −I-15 −I-37; I-38a −I-37; I-39/LK-07b −I-38; I-37 −I-15 (lead decision; record the reason in the plan).
