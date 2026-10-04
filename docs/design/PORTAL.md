# Polaris Key customer portal: design specification

**Status:** draft for owner approval, revised with the owner decisions of 2026-10-04 (Appendix C)
· **Scope:** the customer-facing site at `key.plrs.im`: the SPA at `packages/admin/src/portal`
(served at `/`), the hosted login card every sign-in goes through, and the Worker routes they call
in `packages/worker/src/services/identity/portal` · **Builds on:** [BRAND.md](BRAND.md),
`@polaris-key/brand`, the console kit described in [ADMIN.md](ADMIN.md), the Identity service in
S-16 (`docs/research/2026-09-29-godot-omniplatform/notes/S-16-identity-service.md`) ·
**Baseline:** `ece22812` · **Mockups:** [portal/](portal/) (42 screens × desktop and phone × dark
and light)

This document **supersedes** the portal parts of ADMIN.md: §2.7 (portal IA), §6.10 (portal
screens) and Chunk 12 (§7.2). Chunk 12's scope is replaced by the PX work packages in §11. The rest
of ADMIN.md is unchanged.

**Naming.** The product is called **Polaris Key**, everywhere: the header lockup, page titles
("Library · Polaris Key"), emails, sign-in copy and this document's UI strings. Never "Polaris Key
Portal". "Customer portal" survives only as an internal and glossary term for this surface.

Terminology follows the glossary (`packages/docs/src/content/docs/start/concepts.md`, AGENTS.md
rule 4): **license** (US spelling, in UI copy too), **device**, **product**, **tier**, **customer
portal**. The S-16 nouns are **user** (product-scoped), **portal account** (the one cross-product
record, called "your account" in the UI) and **identity link** (called a **sign-in method** in the
UI).

---

## 0. What Polaris Key is for

Polaris Key is where someone who got a game or app from a developer that uses Polaris Key goes to
**see what they own, get to it, and add more**. Think of it as a small Steam: a **library** first, a
**Discover** shelf of things they can add for free, and one account with many ways to sign in. It
is not the developer's console, and it does not sell anything.

### 0.1 What "done" looks like

1. **Ownership at a glance.** The Library is the default page, on load and after every deep link
   that doesn't name another page: one tile per product, never one per order or license. A person
   with one product, three or forty can see everything they own and its state without scrolling
   past anything else.
2. **Free things are one tap away.** Discover lists every product the signed-in person is eligible
   for (auto-issue policy, tier, group membership, email domain) without issuing anything; **Add to
   library** mints the license on the spot.
3. **One obvious next action per product,** chosen from the license model and the device in hand:
   _Download for macOS_, _Get it on the App Store_, _Activate on Steam_, _Free up a device_,
   _Open Quill_, _Set up package access_.
4. **Every product has one complete page:** get it, Cloud Sync (when the product has it), what's
   new, license, devices, package access, help. Nothing about a product lives anywhere else.
5. **One login card for every sign-in.** Signing in to Polaris Key, signing in to an app through
   Polaris Key, and approving a TV all use the same card. When an app asked, the card says so in a
   persistent header from the first step to the last.
6. **A person, not a login.** The account is the person; Apple, Google, Steam, email and passkeys
   are keys to it, connected and disconnected any time from Account → Sign-in methods.
7. **The top reason a gamer visits, a device limit, takes under a minute,** from the app's error
   to "Try again".
8. **Honest everywhere.** No guessed CPU architecture, no fact only in a tooltip, no
   "this tab will update" that doesn't, no dead-end "Needs attention", no sync status for a
   product that doesn't sync.
9. **Modern and on-brand.** Dark-first with full light parity, Rubik 400/700, neutral violet
   chrome, colour from the developers' own art. Works at 360 px with no horizontal scroll.
   WCAG 2.2 AA.

### 0.2 Design principles

| Principle                                 | In practice                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Products, not paperwork**               | Licenses, keys, orders, releases and Cloud Sync are details of a product, never top-level navigation. The top level is Library and Discover only.                                          |
| **One lead per view**                     | Exactly one solid violet button per region: the hero, the attention shelf, the product header, the login card. Tiles, rows and header actions are outlined.                                |
| **Developer identity is content**         | Key art, icon, name and "by developer" carry the product's identity, inside a fixed Polaris Key frame. The site is never re-themed per product (S-16 §5.6).                                |
| **Say why, then what to do**              | Every non-active status carries its reason and the action that fixes it, in visible text. Every Discover offer says why you can add it.                                                    |
| **The device in hand decides the action** | Desktop: download for the detected OS. Phone: store link, or email the desktop link to yourself.                                                                                           |
| **Progressive scale**                     | Search, filters, sort, list view and the ⌘K palette appear only when the library is big enough to need them.                                                                               |
| **Nothing guessed, nothing hidden**       | Universal builds are named as such; checksums are visible; gated builds say "Not included" and why; a product without Cloud Sync shows no sync anything.                                   |
| **Storefront-easy sign-in**               | Identifier-first, one primary per step, three providers at most, the method you used last offered first, never a password. Modelled on Nintendo, Steam, PlayStation, Xbox, Epic and Apple. |

### 0.3 The brand contract

The site is a **core** surface (BRAND §6 rule 0): the Pinned K with **no section bit**, the core
violet accent, no `data-service` attribute. Specifically:

- **Header:** 64 px, `surface-page` with a `border-subtle` bottom edge, the kit's compact lockup
  (`kit/02-lockups/key/key-compact-{dark,light}.svg`, via `<PolarisLockup variant="compact">`) at
  64 px height. Phones: 56 px. No "Powered by Polaris Key" badge anywhere (BRAND owner decision
  2026-10-03).
- **Type:** Rubik 400 and 700 only (`font-synthesis: none`). Mono is the platform stack for keys,
  codes, hashes, versions and token prefixes only.
- **Colour:** neutral chrome; `--pk-accent` (core violet) only for primary buttons, the active nav
  underline, selection, focus and small counts. Gold (`--pk-signed`) only on _Signed_ chips.
  Status colours always with an icon and a word.
- **Illustration:** the stationary star (BRAND §7.7) is the only illustration, on empty, error and
  no-context screens. A sparse static star field sits behind the login card on wide screens. Nothing
  animates.
- **No gradients** in chrome or fallback art. Developer key art is the developer's content and is
  shown as supplied.
- **Theme:** dark first, following the system, with a persisted "Match my device / Dark / Light"
  choice in Account (BRAND §3, §9.6), applied by an inline `<head>` script before first paint.

---

## 1. Why a redesign

The audit of `main` (88 captures, axe on each) found a stripped-down console rather than a
customer surface. The findings that shape this design, most severe first:

| ID    | Finding                                                                                                                                                    | Answered by                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| PA-1  | **P0.** Every signed-in screen scrolls horizontally at 390 px; the header does not fit and sign-out is off-screen. No mobile nav.                          | §8, the bottom bar         |
| PA-2  | **P0.** The only device action (Disconnect) is off-screen on phones inside a scrolling table.                                                              | §4.22, device rows         |
| PA-3  | **P1.** No product-first view: products are only group headings; downloads are one global chronological list, unlinked from licenses.                      | §3, §4.13–4.20             |
| PA-4  | **P1.** Downloads: no platform detection, no latest-vs-older, no channel grouping, inconsistent version prefixes, SHA-256 returned but never shown.        | §4.20 Get it               |
| PA-5  | **P1.** Expired and disabled licenses show only "Needs attention"; past expiry dates read "Expires …"; no "expires in 9 days".                             | §5.3 status model          |
| PA-6  | **P1.** Why a download is blocked lives only in a `title` tooltip.                                                                                         | §4.20, "Not included" rows |
| PA-7  | **P1.** Licensed builds hosted on R2 (`dl.plrs.im`) can never be downloaded from the portal.                                                               | Gap G3, PX-W3              |
| PA-8  | **P1.** Raw "portal api 404" errors with no retry or way back.                                                                                             | §4.28, §6.4                |
| PA-9  | **P1.** "This tab will update after you use it" is false; no resend, no change-email.                                                                      | §4.4                       |
| PA-10 | **P2.** Jargon: "Continue with OIDC", "Refresh session", "Keys 1 / 2", "authorized/deauthorized", slugs and raw ids in notice emails.                      | §6                         |
| PA-11 | Data returned but never shown: `productBranding`, `activatedAt`, `maxOfflineDays`, `minVersion/maxVersion`, device platform/arch/firstSeen, release notes. | §4.20                      |
| PA-12 | `DELETE /api/me` works and has no UI; profile is read-only; no theme control.                                                                              | §4.26                      |
| PA-13 | axe: icon-only profile link with no name, heading order, empty table header, no `h1` on sign-in and boot; 32 px touch targets with 12 px text.             | §9                         |

Today the SPA is four files (`App.tsx` at 1,118 lines, `main.tsx`, `api.ts`, `format.ts`), so this
is a rebuild on the console kit rather than a restyle.

## 2. How the direction was chosen

Research covered 20 portals and patterns (Steam, itch.io, GOG, Epic, Humble, JetBrains, Microsoft,
Apple, Gumroad, Lemon Squeezy, Paddle, Stripe, Keygen, Sketch, Setapp, 1Password, Raycast, the FIDO
passkey guidelines, platform-detection practice and GitHub token practice), a full audit of the
current portal, and a journey map for eight personas. Three directions were mocked in full and
critiqued.

| Direction           | Verdict               | What we kept                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A · Library**     | **Base** (scored 8.5) | Game-launcher library tiles, the 1 → 3 → 12 growth, the store-style product page, the device-limit flow, product-contextual sign-in, the mobile tab bar.                                                                                                                                                 |
| **B · Account hub** | Grafts (8.0)          | The dense list view with Status / Latest / Devices / Quick action columns; outlined quick actions; the platform grid with Extras and "links are made fresh"; the Account IA (emails, passkey cards, linked accounts, connected products, sessions); the per-product sign-in card; "+1 not using a seat". |
| **C · Spotlight**   | Grafts only (6.5)     | The ⌘K palette; the sticky in-page TOC on the product page; the inline device-removal confirmation; the conditional-UI passkey suggestion; the "Also yours on" store row; the tint-and-letter fallback art.                                                                                              |

Rejected: C's single-product hero on the home page (with 12 products one item still takes the
first screen, and names truncate), B's right rail on the home page, icon-only download buttons,
and 12 identical solid violet buttons on a grid.

Patterns adopted from the research (benchmark ids in brackets): library-first home (P1), one
contextual action (P2, P13), product page as the one home (P3), platform-aware downloads with
honest architecture (P4, A8), self-serve device release with consequences (P5, A7, A12), automatic
attachment plus explicit claim (P6), single-task deep links (P8), search and filters with a visible
reset (P9, A4), entitlement-aware versions (P12), hide empty sections (P14). Anti-patterns avoided:
install hidden in order history (A1), ownership split by order (A2), launcher promoted like the
product (A3), feeds crowding the library (A5), a device list that is really sign-in history (A6),
a secret shown in full (A11).

---

---

## 3. Information architecture

### 3.1 Model

```
Account (one per person; "portal account" in S-16)
 ├─ sign-in methods (S-16 identity links): Apple · Google · Steam · Game Center / Play Games (in-app only)
 │                                          · email addresses (code or link) · passkeys
 ├─ sessions (browsers and apps signed in to the account)
 └─ connected products ─┐
                        ▼
   Product (developer's)          ← one library tile, one product page
    ├─ product user (S-16; how that product knows the person)
    ├─ license(s)                  ← usually one; a base license plus a store grant is possible
    │   ├─ key (only the end is shown) · tier · update window · offline days · key entries (S-16)
    │   ├─ devices (seats)         ← product devices, not account sessions
    │   └─ registry tokens (F-21)
    ├─ Cloud Sync (its own service, per product; S-17) ← only when the product turns it on
    ├─ releases → builds per platform, extras, release notes
    └─ store listings (App Store, Play, Steam, Microsoft Store, Flathub …)

Discover = products whose license policy would auto-issue to this account (evaluated, not issued)
```

The library aggregates by **product**. When a person holds several licenses for one product, the
product page shows the best one (by status precedence, §5.3) with a license switcher in the
License card ("2 licenses · Pro, Edu"). Per-license sections (Devices, Package access) follow the
switcher.

### 3.2 Global elements

| Element               | Desktop (≥ 761 px)                                                                                                                                    | Phone (≤ 760 px)                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header                | Compact lockup · **Library** (count) · **Discover** (count of offers) · spacer · ⌘K trigger (8+ products) · **Activate license** · account menu       | Compact lockup · search icon (8+ products) · avatar (account menu)                                                                                             |
| Primary navigation    | Library and Discover only, with a 2 px violet underline on the current one. Library is the default route.                                             | Bottom bar: **Library** · **Activate** (an outlined pill button in the middle, not a tab) · **Discover** (with a dot when there are offers); safe-area padding |
| Activate license      | Right-aligned, next to the account menu, separate from the nav: an outlined button with the key glyph in `accent-fg`. Always opens the modal (§4.17). | The middle pill of the bottom bar                                                                                                                              |
| Account menu          | Avatar, email (truncated), chevron. Menu: Account · Sign-in methods · Approve a new device · Appearance · Help · Sign out                             | Avatar opens the same menu as a sheet                                                                                                                          |
| Footer                | "Polaris Key · key.plrs.im" · Help · Privacy · Terms                                                                                                  | Same, above the bottom bar                                                                                                                                     |
| Focused flows (§4.25) | Minimal header: lockup and a back-to-app link; no nav                                                                                                 | Same                                                                                                                                                           |
| The login card (§4.1) | Centred 456 px card on the star field, lockup above, footer below; no nav                                                                             | Full-width card under a 56 px lockup row                                                                                                                       |

Account is not a top-level page: it lives behind the account menu.

### 3.3 Routes

Hash routing stays for the signed-in SPA (ADMIN.md lead decision Q2). Product ids in URLs are product
**slugs**. The login card lives on real paths because apps and emails link to it.

| Route                                  | Screen                                                       | Notes                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `#/`                                   | **Library** (default)                                        | `?view=grid\|list`, `?q=`, `?filter=attention\|games\|apps`, `?sort=recent\|name`                           |
| `#/discover`                           | Discover                                                     | `?added=<product>` shows the just-added state after a reload                                                |
| `/activate?key=…` → `#/?activate=…`    | **Library with the Activate license modal open, key filled** | Path form for apps and emails (short, printable); signed out → login card, then here. Never a separate page |
| `#/p/:product`                         | Product page                                                 | `?license=<id>` picks a license when there are several                                                      |
| `#/p/:product/:section`                | Product page scrolled to a section                           | `get`, `sync` (only when the product has Cloud Sync), `new`, `license`, `devices`, `package`, `help`        |
| `#/p/:product/free-device`             | Focused flow: device limit                                   | `?for=<label>&return=<url>`; target of G15 `manageUrl`                                                      |
| `#/p/:product/download`                | Focused flow: one download                                   | `?platform=macos\|windows\|linux…`; for email links and in-app "Download update"                            |
| `#/account` / `#/account/:section`     | Account                                                      | `methods`, `products`, `sessions`, `appearance`, `data`                                                     |
| `#/account/link`                       | Link an existing account (login card, §4.12)                 | Proof of both identities in one session                                                                     |
| `#/account/approve?code=`              | Approve a new device (dialog over Account, §4.24)            | Target of the QR code; the code is typed when absent                                                        |
| `/signin`                              | The login card                                               | `?product=<slug>` gives product context; `returnTo` kept                                                    |
| `/authorize?…` (S-16 broker / I-16 OP) | **The login card with the app header** (passthrough)         | The app's identity comes from its registered client (§10.5), never from query parameters                    |
| `/tv` (and `/device`)                  | Device-code entry → login card with the app header and code  | RFC 8628 `verification_uri`; `verification_uri_complete` pre-fills the code                                 |
| `/signin/device`                       | Sign in with another device: QR and code (§4.23)             | Polled; completes when a signed-in session approves                                                         |

**Redirects (stable links, anti-pattern A10):** `#/licenses` → `#/`; `#/licenses/:p/:id` →
`#/p/:p/license?license=:id`; `#/downloads` → `#/`; `#/profile` → `#/account`; `#/claim?key=` →
`#/?activate=<key>`; `#/account/emails|passkeys|linked` → `#/account/methods`.

**Return URLs** (`return=`, `redirect_uri`) are accepted only when they match a scheme or origin the
product declares (S-16 manifest redirect allowlist); otherwise the flow ends on the product page.

### 3.4 Entry points

| From                                              | Lands on                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| App: `device_limit` error (needs G15)             | `#/p/:product/free-device?for=<this device>&return=<app>`                                               |
| App: key refused, no key entries left (S-16, G21) | `/activate?key=<key>&product=<slug>` → login card with product context → Library with the modal (§4.18) |
| App: "Sign in" (web, native, Godot)               | `/authorize…` → login card with the app header (§4.7)                                                   |
| TV or console: device code                        | `/tv` → login card with the app header and the code (§4.9)                                              |
| Developer's "Manage your license" link            | `/signin?product=<slug>` → login card with context → product page                                       |
| "License added" / "Device removed" emails         | `#/p/:product` or `#/p/:product/devices`                                                                |
| "Sign-in method added/removed" emails             | `#/account/methods`                                                                                     |
| "Email me the download" email                     | `#/p/:product/download?platform=…`                                                                      |
| Typed `key.plrs.im`                               | Library                                                                                                 |

---

## 4. Screens

Each screen lists its purpose, layout, states and data. Images are the dark renders at desktop
width and on a phone; light renders sit beside them in [portal/](portal/) with the `-light`
suffix. The mockup data is invented (Mara Fennick, Sam Okafor and twelve fictional products).

### 4.1 The login card

![Sign in, desktop](portal/01-signin-desktop-dark.png)

<img src="portal/01-signin-mobile-dark.png" alt="Sign in, phone" width="260">

**One card for every sign-in.** Signing in to Polaris Key, signing in to an app through Polaris
Key, a device code from a TV, the account upgrade after a license key, adding a method and joining
accounts all render inside the same `LoginCard`: lockup above, card, footer below, on the static
star field (`surface-page`, no art behind it). The card has three slots:

1. **Card header** (optional, persistent): product context (§4.2) or an app's request (§4.7). It
   stays identical through every step of that flow.
2. **Body:** one step at a time; exactly one primary button.
3. **Card footer** (passthrough only): "Polaris Key signs you in for <App>. <Developer> never
   sees your codes or passkeys." with a lock glyph.

**The first step (identifier-first):**

- `h1` "Sign in to Polaris Key", one line of lede.
- **Email** (`autocomplete="username webauthn"`), so the browser offers saved passkeys as you type
  (conditional UI, drawn on desktop), then **Continue** (the one primary).
- "or", then provider buttons, full width and equal weight (App Review 4.8): **Continue with
  Apple**, **Continue with Google**, **Continue with Steam**. **No other providers; no Discord.**
- **Sign in with a passkey** (ghost button) for people whose browser didn't offer one.
- Quiet links under a rule: **Have a license key?** (§4.5) and **Sign in with another device**
  (§4.23).

**Which providers appear** follows where the product ships (S-16 owner decision): Apple whenever
the product ships on iOS or macOS App Store and offers any social sign-in (always, on the hosted
card, for iOS products); Google for Android/Play and as a general option; Steam for products sold
on Steam. Without product context, all three. Steam sign-in is a **web login** (OpenID on
`steamcommunity.com`), so it is offered on the hosted card on every platform; native Steam ticket
sign-in exists only inside Steam builds. Game Center and Play Games are never buttons on the web:
they connect only from inside an app.

- **States:** default; email invalid (inline under the field, `aria-invalid`); sending (button
  busy); rate-limited ("Too many codes. Try again in 4 minutes."); `email_unavailable` ("We can't
  send email right now. Try another way to sign in."); no method enabled ("Sign-in is turned off for
  this product. Contact Lanternworks.", never an empty card); network error ("Can't reach Polaris
  Key" with Retry, distinct from signed-out).
- **Phone:** the card goes edge to edge under a 56 px lockup row; the star field and the autofill
  drawing are dropped.
- **Data:** `GET /api/capabilities?product=` (methods, providers for the product, presentation from
  G1), session check `GET /api/me`.

### 4.2 Product context

![Sign in with product context](portal/02-signin-product-desktop-dark.png)

From a developer's "Manage your license" link (`/signin?product=nightfall`): the card header shows
the product icon, "Manage your copy of **Nightfall**" and "Lanternworks · downloads, license and
devices". The title becomes "Sign in or create an account", the lede says to use the email the
product was bought with, and the providers are Nightfall's (Google and Steam: Nightfall doesn't
ship on iOS).

### 4.3 Known account: "You usually sign in with Steam"

![Known account](portal/03-signin-known-desktop-dark.png)

After **Continue**, a person this browser has seen before gets an identity chip (avatar, email,
**Change**), "Welcome back, Mara", a hint card **You usually sign in with Steam** ("on this browser,
last time 2 days ago"), that method as the primary, and the generic alternatives **Email me a code**
and **Use a passkey**.

- **No enumeration.** The hint comes from a first-party `pk_last_method` cookie written on this
  browser at the last successful sign-in (method kind and a hash of the email), not from a server
  lookup of the typed address. Typing someone else's email always leads to the generic step (email
  code, passkey, providers), whether or not an account exists, and the hint never lists the account's
  other methods.
- **Unknown or new email:** straight to the code step (§4.4); a new address creates the account
  after the code (§4.10).

### 4.4 Enter the code

![Code entry, desktop](portal/04-signin-code-desktop-dark.png)

- Six one-digit cells (`inputmode="numeric"`, `autocomplete="one-time-code"`, paste fills all
  cells); **Sign in** enables at six digits and submits automatically on the sixth.
- Echoes the address, says how long the code works, and offers **Use a different email**.
- "The email also has a sign-in button. Open it on this device and this page signs you in by
  itself." **True by construction**: the page re-checks `GET /api/me` on `focus` and
  `visibilitychange`, and every 5 s for 10 minutes while visible (ADMIN.md POR-1), and listens on a
  `BroadcastChannel` that the link-verify page posts to.
- **States:** wrong code ("That code didn't work. 3 tries left."); expired; too many tries;
  resend countdown, then **Resend**.

### 4.5 Use a license key

![License-key sign-in](portal/05-signin-key-desktop-dark.png)

The quiet path from **Have a license key?**: one mono field that is tolerant of dashes, spaces and
case and **validates the format as you type** ("12 of 16"), **Continue** (disabled until the
format is valid), and "Lost your key? Sign in with the email you bought with." Each successful use
is a **key entry** (S-16) and leads to §4.6.

### 4.6 Key entry: the account upgrade (skippable, then forced)

![Upgrade, skippable](portal/06-key-upgrade-desktop-dark.png)

![Upgrade, forced](portal/07-key-upgrade-forced-desktop-dark.png)

S-16 owner decision (2026-10-04): a license key has a limited, product-configurable number of
**entries** (5, 10, 25 …), counted across the portal and apps.

- **While entries remain:** a key card (product icon, name, tier, key ending, **Key works**), "Keep
  Nightfall in an account", a segmented **entries meter** ("2 of 5 key entries left · This was entry
  3", used segments in `warning`), email with **Create account**, the product's providers, and
  **Skip for now and open Nightfall** (ghost). "Already have an account? Sign in".
- **Entries used up:** the key card shows **No entries left**; "Create an account to keep
  Nightfall"; a `danger` notice "This key has used all 5 entries. From now on Nightfall is opened
  through an account. It takes a minute, and your license moves in with you."; **no skip**; "Sign in
  to add Nightfall" for existing accounts; and the reassurance "Nightfall keeps working on the
  devices it's already on. Only typing the key again needs an account."
- The license then attaches under the S-16 claim rules (an owned license never moves by key; an
  email-bound license attaches only to that verified email).
- **Apps** refuse the key at the limit and deep-link to `/activate?key=…` (§3.4). Existing licensed
  installs are never affected: device tokens, refresh, offline grace and the signed license document
  keep working.
- Passkeys are not offered here: S-16 registers passkeys only after an email is verified.

### 4.7 App sign-in: the card header

![Web app](portal/08-app-web-desktop-dark.png)

When an app starts sign-in (S-16 broker, I-13 native redirect, I-16 per-product issuer, or RFC 8628
device code), the same card gains a **persistent card header**: the app's icon, "**<App>** wants you
to sign in", and "<Developer> · <where>":

| Variant     | Where line                                 | Example                                      |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| Web app     | Globe glyph and the registered origin      | Quill · Inkwell Labs · quill.inkwell.app     |
| Native app  | Device glyph and "on <device name>"        | Tidewater Studio · on Mara's MacBook Pro     |
| Device code | TV glyph, "on <device name>", and the code | Drift Kart · on Living room TV · `WDJB-MJHT` |

- The header stays through **every** step: method choice, code, registration, confirm and the
  return screen.
- **App branding is data only:** icon, name, developer, origin and device label, rendered by Polaris
  Key inside a fixed frame. No custom HTML, CSS, colours or copy. Names are checked against a
  reserved list (Polaris, Polaris Key, Apple, Google, Steam, Valve …) at registration; the origin
  shown is the registered redirect origin, never a query parameter.
- The card footer names who handles the sign-in (§4.1).

### 4.8 App sign-in: native app steps

![Known account in an iPhone app](portal/09-app-native-known-desktop-dark.png)

![Code](portal/10-app-native-code-desktop-dark.png)

![Register](portal/11-app-native-register-desktop-dark.png)

![Confirm](portal/12-app-native-confirm-desktop-dark.png)

![Return](portal/13-app-native-return-desktop-dark.png)

- **Method choice** is the §4.1/§4.3 body. The Saltwind render shows the case S-16 cares about:
  an iPhone user who registered through Steam signs in with **Continue with Steam** on the hosted
  card ("Opens Steam's sign-in page. You don't need the Steam app.").
- **Code** is §4.4 with "Continue".
- **Register** (new account after a verified code): "Create your account", a `success` line
  "mara@fennick.studio is verified", **Your name** ("Shown to you and in emails. Developers see it
  only when you continue to their app."), an opt-in checkbox "Add a passkey after this, so next time
  is one tap", **Create account and continue**, and the terms line naming both Polaris Key's terms
  and the developer's.
- **Confirm** (every first sign-in to an app, and whenever what it gets changes): the person row
  (avatar, name, email, **Not you?**), "Continue to Tidewater Studio as Mara?", and **what it
  gets** as a list: its license ("Your Tidewater Pro license · Lifetime · this Mac becomes device 3
  of 3"), **Cloud Sync** (only when the product has the service on; what it syncs), and name and
  email. "It won't see your other products or how you sign in." **Continue to Tidewater Studio**
  and **Cancel**. Later sign-ins skip this step.
- **Return:** a success mark, "You're signed in to Tidewater Studio", **Return to Tidewater
  Studio** (re-fires the redirect / app link), "You can close this tab. Open your library".

### 4.9 App sign-in: device code (TV, console)

![Device code](portal/14-app-device-desktop-dark.png)

![TV signed in](portal/15-app-device-done-desktop-dark.png)

- Reached from `/tv` (type the code) or the TV's QR (`verification_uri_complete`). The header adds a
  code panel, "Code from your TV · WDJB-MJHT · Check it matches the screen".
- Body: "Sign in to finish on your TV · Use your phone or computer here. The TV signs in by itself
  when you're done." then the §4.1 methods (Drift Kart: Steam and Google), and "Didn't start this on
  a TV? Cancel it. Someone may be trying to use your account."
- Signed in already: straight to the confirm step (§4.8) with the device name.
- Done: "Drift Kart is signed in on Living room TV · Look at your TV: it continues by itself", the
  person row with the method used, and **Sign the TV out** for the wrong account.

### 4.10 Add another way to sign in (nudge)

![Add another method](portal/16-add-method-desktop-dark.png)

After a first sign-in with a platform identity (Steam, Apple, Google, Game Center), a skippable
card: "Signed in with Steam · marafox · Done", "Add another way to sign in · If you ever can't get
into Steam, a second way in keeps your library yours", rows for **Add your email** (recommended:
purchases with it join the library and it unlocks passkeys), **Add a passkey** ("Asks for your
email first"), **Apple**, **Google**; **Skip for now**; "You can add these any time in Account →
Sign-in methods". Shown once per account and again only if the account still has a single method
after 30 days.

### 4.11 Link an existing account

![Join two accounts](portal/17-link-account-desktop-dark.png)

For a person who ends up with two accounts, typically after **Sign in with Apple** with Hide My
Email (a `privaterelay.appleid.com` address that can never match their real email). Reached from
Account → Sign-in methods → **Link an existing account**, the nudge, and the claim error "owned by
another account" (§4.19).

- The person signs in to the other account **in the same session** (any of its methods); only then
  does the join screen appear: both accounts as cards with their identity, **how each was proven**
  ("Proven by Apple just now", "Proven by email code") and what each holds; the consequences (all
  13 products in one library; every method from both keeps working; which email stays primary; both
  addresses are emailed); **Join into one account** and **Cancel**.
- **Never by email match.** Accounts join only with proof of both identities in one session (S-16
  linking policy: explicit linking, block on conflict). Joining is audited, emailed to both, and
  undoable for 72 hours from either account.

### 4.12 Library: empty

![Empty library](portal/18-library-empty-desktop-dark.png)

- One `text-strong` line naming the signed-in email ("Nothing here for mara@fennick.studio yet"),
  one `text-muted` line, the primary **Activate a license** (opens the modal) and **See 4 in
  Discover**. "Bought with a different email or on Steam? Add it in Account → Sign-in methods." The
  stationary star fills the right half (top strip on phones).
- **Ready to add:** up to three Discover offers as rows (thumb, name, why) with **See all**. Hidden
  when Discover is empty.

### 4.13 Library: one product

![Library with one product](portal/19-library-1-desktop-dark.png)

- A full-width **hero**: key art (left, 1.45 fr) and a side panel with icon, name, developer,
  status and tier, the **primary download** as a two-line button, an **Also yours on** row, a short
  summary (license, devices, includes, plays on) and a link to the product page.
- A closing line: "That's everything linked to <email>. There are 4 more you can add in Discover."
- **Phone:** the art becomes a 16:9 strip; the primary action becomes the phone action.

### 4.14 Library: a few products (2–7)

![Library with three products](portal/20-library-3-desktop-dark.png)

- A 3-column grid of large **library tiles** (§5.2). No toolbar.
- Every tile's action is the **outlined quick action**; solid violet is reserved for the hero, the
  attention shelf and the product header.

### 4.15 Library: many products (8+), grid and list

![Library with twelve products](portal/21-library-12-desktop-dark.png)

![Library list view](portal/22-library-12-list-desktop-dark.png)

<img src="portal/21-library-12-mobile-dark.png" alt="Library with twelve products, phone" width="260">

- **Toolbar:** search ("Search 12 products", `/` focuses it), filter chips with counts (All,
  Needs attention, Games, Apps & tools; a zero-count chip is hidden), sort (Recently added, Name),
  and a Grid/List toggle, all in the URL (§3.3); a non-"All" filter shows "Showing 3 of 12 · Show
  all" (A4).
- **Needs attention shelf:** only items the person can act on, each with a solid primary action:
  device limit → **Free up a device**; expires within 14 days → **Renew with <developer>** (G16, else
  "Contact"); Steam key not activated → **Activate on Steam**; expired with a newer version →
  **Renew**. Never news. Hidden when empty.
- **All products:** 4-column compact grid (3 at 761–1179 px), or the **list**: icon · Product ·
  Status · Latest · Devices · **Quick action for this Mac** · chevron; 72 px rows; the whole row
  opens the product page.
- **⌘K trigger** in the header (§4.27). Products without art use the fallback (§5.2).
- **Phone:** search and view toggle share a row, chips scroll; **List by default above 6
  products** (the remembered choice wins); list rows keep a status pill under the name.

### 4.16 Discover

![Discover](portal/23-discover-desktop-dark.png)

![Just added](portal/24-discover-added-desktop-dark.png)

![Nothing to add](portal/25-discover-empty-desktop-dark.png)

**Purpose:** show every product the signed-in person could add right now for free, so nothing they
are entitled to sits unclaimed.

- **Who sees what.** Discover lists a product when its license policy **would auto-issue** a license
  to this account on first load: the product's auto-issue rule, `groupRoleMap` (a group the account
  belongs to through a connected identity), the tier rules, or an auto-link policy such as a
  verified email domain. Eligibility is **evaluated without issuing** (§10.2, G24).
  **Purchase-only and operator-issued products never appear**, nor do products already in the
  library or ones whose developer turned Discover off.
- **Layout:** `h1` "Discover", one lede ("Products their developers offer to your account. Adding
  one gives you its license straight away, at no cost."), a 4-column grid of **Discover tiles**:
  art, icon, name, developer, **what you'd get** (tier and terms, from the same policy: "Lifetime ·
  5 devices", "Beta · 90 days · 2 devices"), platform glyphs, **why you can add it** ("Free with a
  Polaris Key account", "Free for everyone with an account", "Open beta for Aperture Seven
  customers", "For everyone with a fennick.studio email"), and **Add to library** (outlined).
  Footnote: "Only products you can add for free appear here. Anything you buy shows up in your
  library by itself."
- **Add to library** mints the license on the spot through the same path as auto-issue (same tier,
  limits and entitlements). The tile turns green-edged with **In your library** on the art and
  **Open <product>**; a toast "Mossgarden is in your library · Open"; the Library count goes up and
  the Discover count down. Errors are inline on the tile ("Aperture Seven stopped this offer.").
- **Empty:** the star, "Nothing to add right now", "When a developer offers something to your
  account, like a free game, a beta or an app your team gets, it appears here.", **Back to your
  library**.
- **Nav count:** Discover shows the number of offers as a small violet count (a dot on the phone
  bar). It never nags beyond that: no badges on the library, no emails about offers.

### 4.17 Activate license: the modal

![Enter a key](portal/26-activate-key-desktop-dark.png)

![Confirm](portal/27-activate-confirm-desktop-dark.png)

![Done](portal/28-activate-done-desktop-dark.png)

Opened by the header action, the phone bar pill, ⌘K, the empty library, the not-found page, and
`/activate?key=`. **Always a modal over the Library** (a bottom sheet on phones); there is no redeem
page.

1. **Enter:** "Activate a license", one line ("Type or paste a key from a store, a developer or an
   email. The product joins your library and stays there, even if you lose the key."), the mono key
   field: dashes, spaces and case don't matter; it is normalised and grouped as you type, the format
   is validated live ("14 of 16"; a character outside the alphabet is flagged at once), **Continue**
   enables when the format is valid.
2. **Confirm:** the product's key art across the top of the modal, the icon overlapping it, "Key
   recognised · Mossgarden · Little Fern", `h2` **Add Mossgarden to your account?**, the tier tag,
   the terms ("Lifetime · up to 5 devices") and platforms, the key echoed with **Change key**, and
   **Back** / **Add Mossgarden**.
3. **Done:** the art with **In your library**, "Mossgarden is in your library · Download it, see
   your license and manage devices on its page. You won't need the key again.", **Activate another**
   and **Open Mossgarden** (the product page; focus lands on its `h1`).

### 4.18 Activate license: deep link

![Deep link](portal/30-activate-link-desktop-dark.png)

`/activate?key=…` (from an app at its entry limit, an email, a printed card) opens **Library** with
the modal open and the key filled in and checked. With `product=` from an app, a notice names it:
"Mossgarden sent you here. This key has no entries left in the game. Add it to your account and the
game signs you in instead." The help line reads "Filled in from your link. Check it matches the key
you have." Signed out, the login card (with product context) runs first and returns here.

### 4.19 Activate license: errors

![Error states](portal/29-activate-errors-desktop-dark.png)

Inline under the field (S-16 claim rules), never a toast:

| Case                         | Copy and action                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Not a key (format)           | Live while typing: "That doesn't look like a license key. Check for missing characters."                                                                                                               |
| **Unknown key**              | "We couldn't find that key. Check it against your receipt: 0 and O, 1 and I are easy to mix up."                                                                                                       |
| **Owned by another account** | "This Nightfall license is already in another Polaris Key account. A license never moves by its key." Notice: "If that account is yours too, sign in to it and join the two. Link an existing account" |
| **Verified-email mismatch**  | "Lumen RAW was bought with m•••@proton.me. It joins only the account with that email verified." **Add and verify that email** (unless the product sets `claimByKey`)                                   |
| **No key entries left**      | A `warning` notice, not a block, when signed in: "This key has used all 5 entries. Add it here and Ember Tactics signs you in instead of asking for the key." **Continue** stays enabled.              |
| Already yours                | "Mossgarden is already in your library." **Open it**                                                                                                                                                   |
| Product portal off           | "Little Fern manages this license elsewhere."                                                                                                                                                          |

The masked email shows the first character and the domain only. All lookups share the claim rate
bucket (THREAT-MODEL: enumeration).

### 4.20 Product page

![Product page with Cloud Sync](portal/31-product-sync-desktop-dark.png)

![Product page without Cloud Sync](portal/32-product-no-sync-desktop-dark.png)

<img src="portal/31-product-sync-mobile-dark.png" alt="Product page, phone" width="260">

**Header:** back link to Library, the 320 px key-art banner (16:9, full-bleed on phones), the
112 px icon overlapping its lower edge, the name as `h1`, "by <developer>", status pill and tier,
and the **primary action** with an overflow menu (Copy link, Contact developer, Remove from
library).

**Layout:** at ≥ 1180 px three columns: a sticky **in-page table of contents** (148 px: Get it,
Cloud Sync, What's new, License, Devices 2/3, Package access, Help), the main column (Get it,
**Cloud Sync**, What's new, Package access) and a 384 px side column (License, product sign-in,
Devices, Help). At 761–1179 px the TOC hides. On phones one column in task order (Get it, License,
Devices, Cloud Sync, product sign-in, What's new, Package access, Help) under **sticky pill tabs**.
Sections that don't apply are **omitted**, with their TOC entry (P14).

**Get it:** the recommended panel (honest platform detection: a Universal build is named as such;
both Mac builds otherwise, Apple silicon first), **Change platform**, **Also yours on** store pills
(App Store, Google Play, **Steam: Activate key** with the `registerkey` link, Microsoft Store,
Flathub), **All platforms** grouped by OS then **Extras**, each file with a copyable middle-truncated
SHA-256, and "Download links are made fresh when you click". Phone: "On this iPhone" with the store
action and **Email me the desktop links**.

**Cloud Sync** (only when the product has the Cloud Sync service turned on, S-17):

- What it keeps in step, in the developer's words ("Tidewater keeps your presets, templates and
  preferences the same on every device you sign in on").
- **Storage used** as a figure and a bar ("142 MB of 1 GB used").
- **What's synced:** one row per data class the product declares (Presets · 128 items · 38 MB;
  Project templates · 14 items · 96 MB; Preferences · Audio, MIDI, keyboard shortcuts · 8 MB).
- **Last sync per device:** device, "This device", when, and state ("Up to date", "Preferences
  only", "Waiting to upload", "Conflict: open Tidewater to choose").
- **Export synced data** (a zip, emailed link for large exports) and **Delete synced data**
  (inline confirmation with step-up; "Deleting clears the copy in Cloud Sync. Files already on your
  devices stay there.").
- **Products without the service show no sync status or setting anywhere:** not on the page, not in
  the TOC, not in the library, not in the list view, not in ⌘K. The confirm step of app sign-in
  mentions Cloud Sync only for products that have it.

**What's new**, **License**, **"<Product> knows you as …"** (the identity this product uses, with
**Manage sign-in methods**), **Devices** (seat meter, rows with **Remove**, dormant rows), **Package
access** and **Help** are unchanged from the converged design: every non-covered build is listed
with **Not included** and its reason as text; the key shows only its end with **Get a new key**
(G7); devices show "+1 not using a seat"; package tokens show prefix, last used, expiry and the
amber "Expires in 6 days" pill.

**States:** loading (skeleton header and two skeleton cards); not found (§4.28); load error
(`ErrorState` with Retry); license expired (a `danger` callout with **Renew with <developer>**);
suspended by the developer; account-bound product (Get it becomes **Open Quill** plus store links;
no key, no Devices).

### 4.21 Package token created

![Token created](portal/33-product-token-desktop-dark.png)

A dialog (bottom sheet on phones) that cannot be dismissed by scrim click or Escape until the token
is copied or **I've saved it** is pressed (`OneTimeSecretPanel`): the token with **Copy**, its name,
scope and expiry, and the snippet with the real token inlined.

### 4.22 Remove a device (inline)

![Remove a device](portal/34-product-remove-device-desktop-dark.png)

**Remove** expands the row in place into a `danger-subtle` panel with the consequences (the seat is
free straight away with the new count; the app on that device asks to activate next time; an email
confirms it), **Remove Studio PC** and **Keep it**. Focus moves to the panel heading.

### 4.23 Sign in with another device

![QR and code](portal/39-other-device-desktop-dark.png)

On a new device, **Sign in with another device** shows a QR code and an 8-character code ("Works for
4:52"), with two ways to approve it: scan with a phone where you're signed in (the phone camera opens
`#/account/approve?code=`), or on that device open Account → **Approve a new device** and type the
code. "Waiting for you to approve it on the other device" polls until approved, denied or expired.

### 4.24 Approve a new device

![Approve](portal/40-other-device-approve-desktop-dark.png)

On the signed-in session: "Approve a new device? · Code K7QP-2MXD asks to sign in to your account",
the requesting device (browser and OS, coarse location, when), a `warning` notice "Only approve if
you started this yourself, on a device in front of you. Nobody from Polaris Key or a developer will
ever ask you for this.", **Deny** and **Approve and sign it in**. Approval is audited, emailed, and
the new session appears in "Where you're signed in".

### 4.25 Device limit: focused flow

![Device limit flow](portal/35-device-limit-desktop-dark.png)

Unchanged: minimal chrome with **Back to Orbit Survey without changes**; "Your license is on 2 of 2
devices" with a full red meter; devices as radio cards with the least recently used preselected;
consequences; **Remove Work laptop and continue**; then "Go back to Orbit Survey and press Try
again".

### 4.26 Account

![Account](portal/36-account-desktop-dark.png)

![Disconnect with step-up](portal/37-account-disconnect-desktop-dark.png)

![Last method guard](portal/38-account-last-method-desktop-dark.png)

Reached from the account menu. A sticky section nav (pills on phones) and one card per section:

**Sign-in methods** (S-16: an account is a person; sign-in methods are keys to it). "Each one is a
key to this account. Connect or disconnect them any time; you need at least one." with **Link an
existing account** in the header. Three groups of rows, each row with the provider glyph, the
**connected identity** (Google address, Steam persona, Game Center alias, "Sam's Apple Account ·
Hide My Email"), when it was connected and **last used**, and its action:

| Group    | Rows                                                                                                                             | Actions                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Accounts | Apple, Google, Steam always listed; Game Center / Play Games only once connected ("connect only from inside a game")             | **Connect** (secondary) or **Disconnect** (ghost)                         |
| Email    | Each verified address: Primary, products it brought in, last used to sign in. **Add an email** (verify by code)                  | **Make primary**, **Remove** (not the primary while it is the only email) |
| Passkeys | One row per passkey: provider name, added, last used and where. **Add a passkey** (disabled with a reason until an email exists) | **Rename**, **Remove**                                                    |

- **Disconnect and remove ask for step-up:** the row expands into a `danger-subtle` panel ("Disconnect
  Steam?"), lists the consequences (you won't sign in with Steam; which other methods remain; which
  products know you through Steam and will ask you to sign in another way; the change is recorded and
  emailed), then "Confirm it's you first" and **Use your passkey to disconnect** (or an email code
  when there's no passkey) next to **Keep Steam**.
- **The last method can't be removed.** When only one method exists its row says **Only method**,
  **Disconnect** is disabled, and a `warning` line explains: "This is your only way to sign in.
  Connect another one first, then you can remove Apple." (S-16 "never orphan").
- **Hide My Email accounts** get a notice at the top: "Already have a Polaris Key account? Hide My
  Email gave us a private address, so we can't match it to your real email. Sign in to the other
  account to join them. Link an existing account".
- Footnote: "Removing a method asks you to confirm it's you. Every change is recorded and emailed to
  <primary email>."

**Connected products:** one row per product user with **the identity it uses** and, when the product
has it, "Cloud Sync on"; **Disconnect** ("signs that product out; its license stays in your
library").

**Where you're signed in:** browsers and apps signed in to the account (never product devices), with
**Approve a new device** and **Sign out everywhere else**.

**Appearance** and **Your data** (Download my data; Delete account with typed confirmation) are
unchanged.

### 4.27 Jump to a product (⌘K)

![Command palette](portal/41-switcher-desktop-dark.png)

From 8 products (⌘K / Ctrl K, the header trigger, the phone search icon), on `cmdk`: **Products**,
**Actions** scoped to the top match ("Manage devices for …", "Cloud Sync for …" only when the
product has it, "Activate a license"), **Recent**. Desktop: a 640 px dialog near the top; phone:
full-screen.

### 4.28 Not found and errors

![Not in your library](portal/42-not-found-desktop-dark.png)

- **Product not in your library:** the star, "That product isn't in your library", who you're
  signed in as, **Back to your library**, **Activate a license**, and links to add another email or
  link an existing account. Never "portal api 404".
- **Can't reach Polaris Key**, **Something went wrong** (with a reference id), and **Signed out
  mid-session** (a toast and the login card with `returnTo`).

---

## 5. Components

### 5.1 Reuse first

The site is built on the console kit in `packages/admin/src/ui/` and `@polaris-key/brand/react`.
New components live in `packages/admin/src/portal/components/` unless the console can use them too.

| Need                   | Use                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Lockup in the header   | `PolarisLockup` (`@polaris-key/brand/react`), compact, theme-driven                              |
| Buttons, icon buttons  | `ui/Button`, `ui/IconButton` (add the `quiet` outlined variant, §5.2)                            |
| Status pills           | `ui/StatusPill` with the status map (§5.3)                                                       |
| Signed chip            | `ui/SignedBadge`                                                                                 |
| Copy, hashes, versions | `ui/CopyButton`, `ui/Hash` (middle-truncated SHA-256), `ui/Version`                              |
| Key display            | `ui/KeyDisplay` (last characters only)                                                           |
| One-time token         | `ui/OneTimeSecretPanel` inside `ui/Dialog`                                                       |
| Dialogs, sheets        | `ui/Dialog`; `ui/Drawer` as the phone bottom sheet                                               |
| Forms                  | `ui/Input`, `ui/form`, `ui/RadioCards` (device picker, theme), `ui/SegmentedControl` (Grid/List) |
| Code snippets          | `ui/CodeBlock` with tabs                                                                         |
| Empty, error, loading  | `ui/EmptyState` (star motif), `ui/ErrorState`, `ui/Skeleton`, `ui/Spinner`                       |
| Toasts, live regions   | `ui/toast` (sonner), `ui/LiveRegion`                                                             |
| Times                  | `ui/Timestamp` (relative, with the absolute date as text in a `title` _and_ on focus)            |
| Kbd hints              | `ui/Kbd`                                                                                         |
| Data table (list view) | `ui/data-table` in client mode                                                                   |

### 5.2 New components

| Component                                                                                                                                                   | Contract                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PortalShell`                                                                                                                                               | Header (lockup, Library/Discover nav, ⌘K, **Activate license** action, account menu), phone bottom bar (Library · Activate pill · Discover), footer, skip link, `main`.                                                                                                                          |
| `AccountMenu`                                                                                                                                               | Avatar chip and menu (Account, Sign-in methods, Approve a new device, Appearance, Help, Sign out); a sheet on phones.                                                                                                                                                                            |
| `LoginCard`                                                                                                                                                 | The one sign-in frame: lockup, card with `header` / `body` / `footer` slots, legal footer, star field. Owns step transitions and focus (each step's `h1` receives focus).                                                                                                                        |
| `CardHeader`                                                                                                                                                | `variant: "context" \| "app" \| "device"`. Props are **data only**: `icon`, `name`, `developer`, `where` (origin or device label), `code`. No children, no HTML, no colours. Reserved-name check happens server-side at client registration.                                                     |
| `MethodStack`                                                                                                                                               | Email (identifier-first) with conditional UI, providers filtered by `capabilities` (Apple, Google, Steam only), passkey button, quiet links.                                                                                                                                                     |
| `UsualMethodHint`                                                                                                                                           | Reads `pk_last_method` and renders "You usually sign in with …"; renders nothing without the cookie.                                                                                                                                                                                             |
| `CodeEntry`                                                                                                                                                 | Six cells, paste, auto-submit, resend countdown, BroadcastChannel and re-check.                                                                                                                                                                                                                  |
| `KeyField`                                                                                                                                                  | Mono, normalises dashes/spaces/case, groups as you type, live format validation with a count, `aria-invalid` and error slot. Used by key sign-in and the Activate modal.                                                                                                                         |
| `AccountUpgrade`                                                                                                                                            | Key card, entries meter, method stack; `forced` removes the skip and switches the notice to danger.                                                                                                                                                                                              |
| `AppConsent`                                                                                                                                                | The confirm step: person row, "what it gets" list (license, Cloud Sync when present, profile), Continue/Cancel.                                                                                                                                                                                  |
| `AddMethodNudge`                                                                                                                                            | Rows of methods to add, recommended first, skip.                                                                                                                                                                                                                                                 |
| `LinkAccounts`                                                                                                                                              | Two proven account cards, consequences, join.                                                                                                                                                                                                                                                    |
| `DeviceApproval`                                                                                                                                            | New-device side (QR, code, poll) and approving side (dialog with device details, deny/approve).                                                                                                                                                                                                  |
| `ProductArt`                                                                                                                                                | `variant: "banner" \| "tile" \| "thumb" \| "icon"`; proxied art (G1) with the flat tint-and-icon / tint-and-letter fallback. No gradients.                                                                                                                                                       |
| `LibraryTile`, `LibraryHero`, `LibraryList`, `AttentionShelf`, `LibraryToolbar`, `QuickAction`                                                              | As in the converged design: art with the status pill on a solid plate, icon overlapping, name, developer, meta, platform glyphs, note, outlined quick action and overflow; the one-product hero; the list on `ui/data-table`; the shelf; the URL-synced toolbar; quick-action resolution (§5.4). |
| `DiscoverTile`                                                                                                                                              | Art, icon, name, developer, offer terms, platforms, "why you can add it", **Add to library** → added state (green edge, **In your library**, **Open**).                                                                                                                                          |
| `ActivateDialog`                                                                                                                                            | Steps enter → confirm (art header, product, tier, terms, key echo) → done; inline errors (§4.19); `prefill` and `fromProduct` props for the deep link. Mounted once in `PortalShell`, opened from anywhere.                                                                                      |
| `JumpPalette`                                                                                                                                               | ⌘K (§4.27).                                                                                                                                                                                                                                                                                      |
| `ProductHeader`, `SectionNav`, `GetItPanel`, `FileRow`, `StoreHandoff`, `LicenseCard`, `SeatMeter`, `DeviceRow`, `PackageAccessCard`, `ProductIdentityCard` | As in the converged design. `SectionNav` omits absent sections, including Cloud Sync.                                                                                                                                                                                                            |
| `CloudSyncCard`                                                                                                                                             | Storage bar, data classes, per-device last sync, export, delete with step-up. Rendered only when the product's `services.cloudSync` is on.                                                                                                                                                       |
| `SignInMethods`                                                                                                                                             | The Account section: grouped rows, connect flows (provider redirect or code), disconnect with inline step-up, last-method guard, audit footnote.                                                                                                                                                 |
| `FocusedFlow`                                                                                                                                               | Minimal chrome and return-URL handling for `free-device` and `download`.                                                                                                                                                                                                                         |

`Button` gains two variants: **quiet** (transparent, `border-strong` outline, `text-strong` label,
icon in `accent-fg`; the library's quick action) and **action** (`surface-raised`, `border-strong`,
key glyph in `accent-fg`; the header's Activate license).

### 5.3 Status model

One status per product (from its best license), computed server-side once G1/G5 land and
client-side from existing fields before then. Precedence, first match wins:

| Status                | Pill (icon · word · token)              | Reason line / note                                 | Attention shelf action |
| --------------------- | --------------------------------------- | -------------------------------------------------- | ---------------------- |
| Suspended             | alert · "Suspended" · danger            | "Suspended by <developer>."                        | Contact <developer>    |
| Expired               | alert · "Expired" · danger              | "Updates ended at 1.8" (or "Ended 4 Sep 2026")     | Renew with <developer> |
| Device limit reached  | alert · "Device limit reached" · danger | "2 of 2 devices"                                   | Free up a device       |
| Key not activated     | key · "Key not activated" · info        | "Steam key"                                        | Activate on Steam      |
| Expires soon (≤ 14 d) | clock · "Expires in 9 days" · warning   | "Studio · ends 13 Oct"                             | Renew with <developer> |
| Offline grace ended   | alert · "Needs a check-in" · warning    | "Open <product> while online"                      | none                   |
| Signed-in app         | user · "Signed-in app" · neutral        | "Sign in on any device"                            | none                   |
| Active                | check · "Active" · success              | tier and devices, e.g. "Lifetime · 2 of 3 devices" | none                   |

A past date is never shown as "Expires …": it is "Ended <date>" or "Updates ended at <version>".
Expiry inside 14 days uses relative days; otherwise "until 14 Mar 2027".

### 5.4 Quick action resolution

| Product state                           | Desktop                                                        | Phone                                                  |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| Device limit reached                    | Free up a device                                               | Free up a device                                       |
| Steam key held, not activated           | Activate on Steam                                              | Activate on Steam                                      |
| Account-bound (no key, no seats)        | Open <product> (website / app scheme)                          | Get it on the App Store / Google Play, else Open       |
| Build for this OS exists and is covered | Download for <OS>                                              | Store link for this OS, else **Email me the download** |
| Covered builds exist, none for this OS  | See downloads (with "Windows and Linux only" as the meta line) | Email me the download / See downloads                  |
| Expired, an older build is covered      | Download <last covered version>                                | Email me the download                                  |
| Only a package feed                     | Set up package access                                          | Set up package access                                  |
| Public product (G19)                    | Open download page (dl.plrs.im)                                | Open download page                                     |

---

---

## 6. Copy

### 6.1 Rules

1. **Plain words.** Never "OIDC", "entitlement", "artifact", "deliverable", "authorized",
   "deauthorized", "session refresh", "claim" or "redeem" (in UI; "add" and "activate" instead),
   "identity link" ("sign-in method"), "merge" ("join"), "account id" as a headline.
2. **Name it "Polaris Key".** Never "Polaris Key Portal", "the portal" or "PK" in UI or email.
3. **No redundant subtitles.** A subtitle earns its place only by saying something the heading
   can't: a rule, a consequence, or who is responsible.
4. **Name the developer.** "Renew with Kiln Games", "Harbor Audio never sees your codes".
5. **Buttons say what happens to what.** "Add Mossgarden", "Continue to Tidewater Studio",
   "Use your passkey to disconnect", "Join into one account". No "Submit", "OK", "Confirm".
6. **Say why, then what to do.** "This is your only way to sign in. Connect another one first, then
   you can remove Apple."
7. **Sentence case** everywhere; status words capitalised as labels.
8. **Providers by their own names:** "Continue with Apple / Google / Steam". No other providers.
9. **Numbers and dates:** "2 of 3", "2 of 5 key entries left", "Expires in 9 days", "until 14 Mar
   2027", "last used 3 weeks ago". Versions without a leading "v", in mono.
10. **Product names, not slugs,** in UI and email.
11. **Don't over-promise.** Only say a page "signs you in by itself" when it does; only mention
    Cloud Sync for products that have it.

### 6.2 Voice samples

| Moment              | Copy                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| Sign in             | "Sign in to Polaris Key"                                                                              |
| Known account       | "Welcome back, Mara · You usually sign in with Steam"                                                 |
| App header          | "Tidewater Studio wants you to sign in · Harbor Audio · on Mara's MacBook Pro"                        |
| App confirm         | "Continue to Tidewater Studio as Mara? · It won't see your other products or how you sign in."        |
| Key upgrade         | "Keep Nightfall in an account · 2 of 5 key entries left"                                              |
| Key upgrade, forced | "This key has used all 5 entries. From now on Nightfall is opened through an account."                |
| Discover            | "Products their developers offer to your account. Adding one gives you its license straight away."    |
| Activate confirm    | "Add Mossgarden to your account?"                                                                     |
| Nudge               | "If you ever can't get into Steam, a second way in keeps your library yours."                         |
| Join accounts       | "We never join accounts just because emails look alike."                                              |
| Approve a device    | "Only approve if you started this yourself, on a device in front of you."                             |
| Cloud Sync delete   | "Deleting clears the copy in Cloud Sync. Files already on your devices stay there."                   |
| Key storage         | "Only the end of a key is kept, so it can't be shown in full. A new key replaces this one."           |
| Delete account      | "Deleting it doesn't cancel your licenses: they stay with each developer and you can add them again." |

### 6.3 Emails

Every email is from "Polaris Key", names the product (not the slug) and the device by label, and
deep-links to the exact section (§3.4). Subjects: "Nightfall is in your library", "Studio PC was
removed from Tidewater Studio", "Your Polaris Key sign-in code: 481 920", "Steam was disconnected
from your Polaris Key account", "A new device signed in to Polaris Key", "Your two Polaris Key
accounts were joined". Security emails (method added or removed, device approved, accounts joined)
always go to every verified email on the account and carry "Wasn't you? Secure your account". The
emails use the kit PNG lockup and no "Powered by" badge.

### 6.4 Error copy

Errors say what happened, in the user's terms, and the next step. Map every flat error code the API
returns (`W/core/errors.ts`) to a sentence; unknown codes fall back to "Something went wrong. Try
again." with the reference id. Never render the HTTP status or an internal code as the message.

---

## 7. Layout and visual details

- **Grid:** content max-width 1312 px with 32 px gutters (16 px on phones). Library grids: 24 px
  gaps for large tiles, 20 px for compact.
- **Radii:** tiles, cards and the hero `xl` (18 px); controls `md`; pills `full`.
- **Surfaces:** page `surface-page`; tiles and cards `surface-raised` with `border-subtle` and
  `elevation-1`; dialogs `surface-overlay` with `elevation-3`; inputs and code `surface-sunken`.
- **Status pills on art** sit on a solid `surface-overlay` plate with `elevation-2` so they read on
  any artwork; the art's own text should avoid the bottom-right corner (developer guidance in the
  listing docs).
- **Type scale:** page `h1` 40/44 (30 on phones); product `h1` 36 (28); card `h2` 18; tile name 18
  (16 compact); body 15–16; metadata 13; group labels and counts 12 bold.
- **Motion:** only the duration tokens (`fast` for hover, `base` for disclosure and the inline
  confirm, `slow` for sheets). Nothing loops. The star never moves.
- **Images:** all developer images are served **same-origin** through the media proxy (G1) because
  the site's CSP is `img-src 'self' data:`; sizes 1280 × 720 banner, 640 × 360 tile, 256 × 256 icon,
  WebP with PNG fallback.

## 8. Responsive rules

| Width       | Library                                                                                        | Product page                                                  | Chrome                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| ≥ 1180 px   | Large tiles 3 columns; compact 4 columns                                                       | TOC · main · side (148 · fluid · 384)                         | Full header                                               |
| 761–1179 px | Large 3, compact 3                                                                             | Main · side (fluid · 340); TOC hidden                         | Full header; ⌘K trigger collapses to an icon below 900 px |
| ≤ 760 px    | One column; List view by default above 6 products; toolbar: search + view toggle, chips scroll | One column in task order; sticky pill tabs; banner full-bleed | 56 px header, bottom tab bar, bottom sheets               |

- **No horizontal page scroll at 360 px**, ever (the render script checks every screen). Only code
  blocks scroll inside themselves.
- **Touch targets** ≥ 44 × 44 px on touch (buttons are 44 px; small buttons 36 px tall with 44 px hit
  areas through padding). The tab bar items are 52 px tall.
- **Tables become rows:** the list view drops columns and keeps status as a pill under the name.
- **Phone actions** replace desktop downloads (§5.4); dialogs become bottom sheets; the palette is
  full-screen.
- Safe-area insets pad the tab bar and sheets (`env(safe-area-inset-bottom)`).

## 9. Accessibility

WCAG 2.2 AA in both themes (BRAND §9), plus:

1. **Landmarks and headings:** a skip link, one `banner`, `nav` (labelled "Main"), `main`, and
   `contentinfo`; exactly one `h1` per screen (sign-in, boot and error screens included); cards use
   `h2`, tiles `h3` (fixes PA-13 heading order).
2. **Names:** every icon-only control has an accessible name ("More for Nightfall", "Copy SHA-256",
   "Open Tidewater Studio"); the avatar link is "Account: <email>"; platform glyph groups are one
   `role="img"` with a list label.
3. **Status** is always icon plus word; the seat meter is `role="img"` with a text label; the
   "Not included" reason is visible text.
4. **Focus:** the violet 2 px ring with 2 px offset everywhere; dialogs trap focus and return it to
   the opener; the inline device confirm moves focus to its heading; after adding a product, focus lands
   on the new product's `h1`.
5. **Forms:** visible labels; errors inline with `aria-invalid` and `aria-describedby`; the code
   cells are one labelled group and accept paste; no information only in placeholders.
6. **Live regions:** search result counts, toasts and download start ("Downloading Tidewater Studio
   2.4.1 for macOS") are announced politely.
7. **Keyboard:** `/` focuses search, ⌘K opens the palette, arrow keys move in the palette, radio
   cards and tabs; everything reachable without a pointer.
8. **Text:** task-critical text ≥ 14 px; 13 px only for secondary metadata; 12 px only for group
   labels and counts; `text-subtle` never carries required information.
9. **Motion:** reduced motion honoured through the duration tokens.
10. **Testing:** `vitest-axe` on every page component; a Playwright axe pass over all states in both
    themes at 1440 and 390 px (PX-15).

---

## 10. Data and API

### 10.1 What the portal API returns today

`GET /api/capabilities[?product=]`, `GET|DELETE /api/me`, `GET /api/licenses`,
`GET /api/licenses/:p/:id`, `POST /api/claim/license-key`,
`DELETE /api/licenses/:p/:id/devices/:deviceId`, `GET /api/releases`,
`POST /api/releases/:p/:r/artifacts/:a/token`, `GET /download/<token>`, plus `/login`,
`/callback`, `/logout`, `/magic/verify` and `POST /api/magic/start`. All are root paths on
`key.plrs.im`; the routes are in the OpenAPI spec and `routeCoverage` (`portalApi`,
`portalDownload`, …), so **rule 10 applies to every new route**.

### 10.2 Gaps the Worker must close

Ids G1–G20 follow the journey research; G21–G23 were added by the converged design; **G24–G30 are
new with the owner decisions of 2026-10-04**. "Fallback" is what the UI does until the gap closes.

| Id      | Need                                                   | Proposed shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Fallback until then                                                        | Gates                                                                                                            | WP                  |
| ------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| **G1**  | Product presentation                                   | From `ManifestListing` (`name`, `developerName`, `iconUrl`, `headerUrl`, `tintColor`, `website`) on `GET /api/library`; same-origin media proxy `GET /media/:product/:asset`                                                                                                                                                                                                                                                                                                                                                                                                                             | Name only; letter-and-tint fallback                                        | Rule 10; CSP test; THREAT-MODEL (SSRF)                                                                           | PX-W1               |
| **G2**  | Store links per product and platform                   | `stores[]` `{kind, platform, url, live}` via a Core hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | "Also yours on" hidden                                                     | Rule 6                                                                                                           | PX-W2               |
| **G3**  | Licensed builds hosted on R2                           | Signed short-lived bytes URL or streaming through `/download/<token>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | "Not available here yet · Contact <developer>"                             | **Plan mode**; THREAT-MODEL; rule 10                                                                             | PX-W3               |
| **G4**  | Downloads shaped per product                           | `GET /api/products/:p/downloads` through a Core hook over `page/model.ts` and `page/detect.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Client groups `GET /api/releases`                                          | Rule 6; rule 10                                                                                                  | PX-W2               |
| **G5**  | Seat limit and dormancy                                | `deviceLimit`, `activeSeatCount`, per-device `dormant`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | "2 devices" without "of 3"                                                 | none                                                                                                             | PX-W1               |
| **G6**  | Device rename                                          | `PATCH /api/licenses/:p/:id/devices/:deviceId {label}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | No rename                                                                  | Rule 10                                                                                                          | PX-W5               |
| **G7**  | Get a new key                                          | `POST /api/licenses/:p/:id/keys` (shown once, step-up, notice); per-product opt-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Hidden                                                                     | Rule 10; D1 migration; `TABLE_OWNERS`                                                                            | PX-W5               |
| **G8**  | Purchase source and store grants                       | Core descriptor hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | "Bought from <developer>" only                                             | Rule 6                                                                                                           | PX-W6               |
| **G10** | Emails, sign-in methods, connected products            | S-16 I-06 / I-15, shaped as in G27                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Account shows the one sign-in email                                        | I-15's gates                                                                                                     | (I-15)              |
| **G11** | Sign-in methods beyond OIDC and link                   | Email code (I-08), passkeys (I-14), Apple (I-20), Google (I-05 discovery), Steam (I-12 web OpenID)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | IdP display name + email link                                              | per S-16 WP                                                                                                      | PX-W4, S-16         |
| **G12** | Server-side sessions, sessions list, export            | I-15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Sign out only                                                              | I-15's gates                                                                                                     | (I-15)              |
| **G13** | Registry tokens                                        | F-21                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Card hidden                                                                | F-21's gates                                                                                                     | (F-21)              |
| **G14** | F-20 path mismatch                                     | Decide `/api/…` vs a `/portal` alias before F-21                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | n/a                                                                        | F-21 plan                                                                                                        | owner               |
| **G15** | Deep links from apps and emails                        | (a) SPA routes; (b) `manageUrl` on `device_limit` **and on the key-entries refusal** (pointing at `/activate?key=`); (c) email links                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | (a) and (c) work alone                                                     | **(b) is a wire change: plan mode, contract → errors.json → corpus → six SDKs**                                  | PX-W8 (with I-04)   |
| **G16** | Developer support and renewal links                    | `supportUrl`/`supportEmail` per product                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Help card hidden                                                           | Rule 9 if validated                                                                                              | PX-W1               |
| **G18** | Notice copy                                            | Product names, device labels, deep links, "Polaris Key" sender                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | n/a                                                                        | none                                                                                                             | PX-W7               |
| **G19** | Public products                                        | Link out to `dl.plrs.im/<product>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | n/a                                                                        | none                                                                                                             | PX-09               |
| **G21** | **Key-entry counting** (S-16)                          | Per license key: `entriesLimit` (product setting, default from the product's policy), `entriesUsed`, incremented atomically on every successful key entry in the portal **and** in apps (activation by key); responses carry `entriesLeft`/`entriesLimit`; at zero, apps get a new refusal with `manageUrl` (G15b) and the portal forces the upgrade                                                                                                                                                                                                                                                     | Upgrade always skippable, no count                                         | Part of the I-04 contract (**plan mode**); D1 migration; `TABLE_OWNERS`; corpus                                  | (I-04), PX-W9       |
| **G22** | Key preview before adding                              | `POST /api/activate/preview` → product name, developer, art, tier, terms; or a typed refusal (`unknown`, `owned_elsewhere`, `email_mismatch` with masked email, `already_yours`, `portal_off`) and `entriesLeft`; never ownership details; same rate bucket as add                                                                                                                                                                                                                                                                                                                                       | Modal adds directly, errors after                                          | Rule 10; THREAT-MODEL (enumeration)                                                                              | PX-W5               |
| **G23** | "Email me the download"                                | `POST /api/products/:p/email-download {platform}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | "Open this page on your computer"                                          | Rule 10                                                                                                          | PX-W7               |
| **G24** | **Discover eligibility listing**                       | `GET /api/discover` → for each product with a policy that **would auto-issue** to this account (auto-issue rule, `groupRoleMap` over the account's connected identities, tier rules, verified-email-domain auto-link): presentation (G1), the tier, limits and terms that would be issued, and a `reason` (`free_with_account`, `group:<label>`, `email_domain:<domain>`, `beta`). Evaluated by the same policy function as first-load auto-issue, in **dry-run** mode: no rows written. Excludes purchase-only and operator-issued products, products already held, and products with `discover: false` | Discover hidden from the nav                                               | Rule 10; rule 6 (policy through a Core hook if it lives in License); unit tests asserting dry-run writes nothing | PX-W10              |
| **G25** | **Discover claim**                                     | `POST /api/discover/:product/claim` re-evaluates eligibility server-side and mints through the **auto-issue path** (identical tier, limits, entitlements, audit `source: discover`); idempotent per account and product; `409 not_eligible` when the offer changed                                                                                                                                                                                                                                                                                                                                       | n/a (with G24)                                                             | Rule 10; audit; rate limit in the `_portal` buckets                                                              | PX-W10              |
| **G26** | **Cloud Sync per product**                             | Cloud Sync is its **own service with its own toggle** (S-17, depends on user-level managed config and product users from S-16 I-06). The portal needs `services.cloudSync` on `GET /api/products/:p` and `GET /api/products/:p/sync` → `{quota, used, classes[{key,label,items,bytes}], devices[{deviceId,label,lastSyncAt,state}]}`, `POST …/sync/export`, `DELETE …/sync` (step-up)                                                                                                                                                                                                                    | Section absent (it is absent for every product without the service anyway) | S-17's gates; rule 10; THREAT-MODEL (export, delete); step-up                                                    | PX-W11 (after S-17) |
| **G27** | **Identity linking endpoints** (S-16 §5.1, I-06, I-15) | `GET /api/me/methods` → links `{id, kind, display, connectedAt, lastUsedAt, canRemove}` plus emails and passkeys; `POST /api/me/methods/:kind/start` (provider redirect, or email code) and its callback; `DELETE /api/me/methods/:id` with a fresh step-up assertion (≤ 5 min), refused with `last_method` when it would orphan the account; `POST /api/me/link/start` and `POST /api/me/link/confirm` for joining two accounts with proof of both in one session (block on conflict; 72 h undo); every change audited and emailed to all verified addresses                                            | Account shows the one sign-in email                                        | I-06/I-15 gates; rule 10; THREAT-MODEL (account takeover via linking); audit                                     | PX-W12 (with I-15)  |
| **G28** | **Passthrough request metadata** (I-04)                | Every app-initiated sign-in (broker, I-13 redirect, I-16 authorize, RFC 8628) resolves a server-side **client record**: `appName`, `developerName`, `iconUrl` (proxied), `kind: web\|native\|device`, registered origins, `services` (license, Cloud Sync) for the consent list; plus request-time `deviceLabel` (from the SDK, length-limited, sanitised) and `user_code` for device flow. Names checked against a reserved list at registration. The login card reads it by an opaque `request` handle, never from display query parameters                                                            | Card header shows the product name only (from `capabilities?product=`)     | Part of the **I-04** contract (**plan mode**): the SDKs send `deviceLabel`; corpus and transcripts               | PX-W13 (with I-04)  |
| **G29** | **Approve a new device**                               | `POST /api/device-login/start` → `{code, qr, expiresIn}` (single-use store, I-02); `POST /api/device-login/approve {code}` from a signed-in session with step-up for new locations; poll `GET /api/device-login/:id`; audited and emailed                                                                                                                                                                                                                                                                                                                                                                | "Sign in with another device" hidden                                       | Rule 10; THREAT-MODEL (phishing: short expiry, location shown, never auto-approve)                               | PX-W14              |
| **G30** | **Last-used method hint**                              | Set `pk_last_method` (HttpOnly not required: kind and a salted email hash, no PII) on successful sign-in; never derived from a server lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No hint                                                                    | THREAT-MODEL note (no enumeration)                                                                               | PX-12               |

Notes:

- **Rule 6.** Identity (where the portal lives) may not import Distribution, Update or License
  internals. G2, G4, G8, G24 and G25 go through descriptor hooks in `src/core/hooks.ts`.
- **One library call.** `GET /api/library` returns, per product: presentation, status and reason,
  best license summary with seats, quick-action inputs and support links, plus the Discover count.
  `GET /api/products/:p` adds licenses, devices, downloads, stores, feeds and `services`.
- **`GET /api/me` stops re-running `syncAccountLicenseLinks` on every call** once `GET /api/library`
  exists; linking moves to sign-in, email verification and adding.
- **Rate limits** stay per-product sharded; the new routes join the `_portal` buckets that S-16 I-02
  shards. Preview (G22), add, and Discover claim share one bucket per account.

### 10.3 S-16 and S-17 dependencies, in the order they unlock UI

| WP       | Unlocks                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| I-01     | Identities keyed by issuer (prerequisite for sign-in methods)                                                             |
| I-02     | Atomic single-use codes: email code (PX-W4), device approval codes (G29)                                                  |
| I-04     | The contract for key-entry limits (G21), `manageUrl` (G15b) and passthrough request metadata (G28)                        |
| I-05     | Google through discovery as a provider                                                                                    |
| I-06     | Product users and links: Connected products, the linking model behind Sign-in methods (G27)                               |
| I-08     | Email login for products: code step inside the app card header                                                            |
| I-12     | Steam (web OpenID on the hosted card; ticket in Steam builds), Game Center and Play Games links                           |
| I-13     | Native redirect: the "native app" card header                                                                             |
| I-14     | Passkeys (`rp_id = key.plrs.im`): passkey button, conditional UI, passkey rows, step-up                                   |
| I-15     | Sessions, export, links to product users, the F-21 revocation hook: Account v2, the product identity card                 |
| I-16     | Per-product issuer ("Sign in with <Product>"): the web-app card header and consent step                                   |
| I-20     | Apple as its own kind (Hide My Email relay handled): Apple button, the Link an existing account notice                    |
| **S-17** | **Cloud Sync as a service and user-level managed config:** the product page Cloud Sync section (G26) and the consent line |

Q-3 of the converged draft (product providers on portal sign-in) is settled by the owner decisions:
**one login card**; providers are Apple, Google and Steam, chosen per product by where it ships; a
platform identity signs in the account and links the product user.

---

## 11. Implementation work packages

Sizes: S ≤ 1 day, M 2–4 days, L 5+ days (agent-days). ⚑ = plan mode. **Every WP** runs the green
gate: `mise exec node@22 -- pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint`,
`pnpm --filter @polaris-key/admin build`, `pnpm --filter @polaris-key/worker assemble`,
`pnpm --filter @polaris-key/docs check:links`, and the pre-commit hook. Worker WPs also run
`typecheck:workerd` and `test:workerd`, and `gen:transcripts -- --check` must stay green unless the
WP is a wire change.

### 11.1 Phase A: rebuild on today's API (no Worker changes)

| ID        | Work package                                                                                                                                                                                                                                                                                                                                                                                                                | Deps  | Size | Extra gates                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- | ------------------------------------------------------------------------------------ |
| **PX-01** | **Shell and data layer.** Split `portal/App.tsx` into pages and components; TanStack Query; hash router with the §3.3 routes and redirects (Library default; `/activate` path handler); `PortalShell` (Library/Discover nav, **Activate license** action, `AccountMenu`, phone bar with the Activate pill); theme persistence; `document.title` "<Page> · Polaris Key"; error mapping; `quiet` and `action` Button variants | none  | M    | Adapt `portal.test.tsx`; redirect tests; no horizontal scroll at 360 px (Playwright) |
| **PX-02** | **Library on today's data.** Client grouping of `GET /api/licenses`; status model; `ProductArt` fallback; `LibraryTile`, `LibraryHero`, 1 / 2–7 / 8+ layouts, `AttentionShelf`; `QuickAction`; the empty state (Activate + Discover teaser hidden until G24)                                                                                                                                                                | PX-01 | M    | Status precedence and quick-action unit tests                                        |
| **PX-03** | **Scale features.** `LibraryToolbar`, `LibraryList`, `JumpPalette` from 8 products                                                                                                                                                                                                                                                                                                                                          | PX-02 | M    | Keyboard tests; axe on palette                                                       |
| **PX-04** | **Product page on today's data.** `ProductHeader`, `SectionNav` (omits absent sections), `LicenseCard`, Devices with inline confirm, What's new and a first `GetItPanel`; not-found and error states                                                                                                                                                                                                                        | PX-01 | L    | Disconnect consequences and focus; reasons as text                                   |
| **PX-05** | **`LoginCard` on today's auth.** The card frame with the header slot (context variant from `capabilities?product=`), IdP display-name button, email link with the honest sent screen, resend and change-email; no-method and network states                                                                                                                                                                                 | PX-01 | M    | Magic-link re-check tests; network vs signed out                                     |
| **PX-06** | **Activate license modal.** `KeyField`, `ActivateDialog` (enter → done; confirm step appears with G22), mounted in the shell, opened from header, bar, ⌘K, empty state and `/activate?key=` (prefill, signed-out round trip); inline errors from today's claim codes                                                                                                                                                        | PX-01 | M    | Deep-link test (signed in and out); focus to the product `h1` after adding           |
| **PX-07** | **Account v1.** Sign-in email, Appearance, Delete account, Sign out; section scaffold for Sign-in methods                                                                                                                                                                                                                                                                                                                   | PX-01 | S    | Typed-confirm test                                                                   |

### 11.2 Phase W: Worker additions

| ID           | Work package                                                                                                                                                                                                               | Deps             | Size | Gates                                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **PX-W1**    | **Library API and media** (G1, G5, G16): `GET /api/library`, `GET /api/products/:p` (with `services`), media proxy                                                                                                         | none             | L    | Rule 10; rule 9; THREAT-MODEL (SSRF); CSP browser test                                                                                   |
| **PX-W2**    | **Downloads and stores** (G2, G4) through Core hooks                                                                                                                                                                       | PX-W1            | L    | Rule 6; rule 10                                                                                                                          |
| **PX-W3** ⚑  | **Licensed R2 downloads** (G3)                                                                                                                                                                                             | PX-W2            | M    | Plan approval; THREAT-MODEL; `test:workerd`                                                                                              |
| **PX-W4**    | **Email code** for the account sign-in on the I-02 store                                                                                                                                                                   | S-16 I-02        | M    | Rule 10; rate limits; enumeration-safe responses                                                                                         |
| **PX-W5**    | **Device rename, new key, activate preview** (G6, G7, G22 with typed refusals and masked email)                                                                                                                            | PX-W1            | M    | Rule 10; D1 migration + `TABLE_OWNERS`; THREAT-MODEL (enumeration)                                                                       |
| **PX-W6**    | **Purchase source** (G8)                                                                                                                                                                                                   | PX-W1            | M    | Rule 6                                                                                                                                   |
| **PX-W7**    | **Emails** (G15c, G18, G23): "Polaris Key" sender and naming, security-notice templates for method and device changes                                                                                                      | PX-01            | S    | Rule 10; email snapshot tests                                                                                                            |
| **PX-W8** ⚑  | **`manageUrl`** (G15b) on `device_limit` and on the key-entries refusal, jointly with I-04: contract → `errors.json` → corpus and transcripts → client-core, Node, React, Python, Swift, Godot, Kotlin and the SDK UI kits | S-16 I-04        | L    | **Plan mode**; `gen:corpus -- --check`; `gen:constants -- --check`; `parity:check`; every SDK's replayer                                 |
| **PX-W9** ⚑  | **Key-entry counting** (G21): limit setting, atomic counter for portal and app entries, portal responses, the app refusal (wire part rides PX-W8)                                                                          | S-16 I-04        | M    | Plan mode; D1 migration + `TABLE_OWNERS`; concurrency test on the counter; installs unaffected (regression on refresh and offline grace) |
| **PX-W10**   | **Discover** (G24, G25): dry-run evaluation of the auto-issue policy, listing, claim through the auto-issue path, `discover` opt-out per product                                                                           | PX-W1            | M    | Rule 6 (Core hook); rule 10; test that listing writes nothing; parity test: Discover claim ≡ first-load auto-issue                       |
| **PX-W11**   | **Cloud Sync API for the portal** (G26) on top of the S-17 service                                                                                                                                                         | S-17, I-06       | M    | S-17 gates; rule 10; step-up on delete; THREAT-MODEL (export)                                                                            |
| **PX-W12**   | **Sign-in methods and linking API** (G27): methods list, connect flows, disconnect with step-up and the last-method refusal, join-accounts with proof of both and 72 h undo, audit and notices                             | I-06, I-14, I-15 | L    | Rule 10; THREAT-MODEL (takeover via linking); audit; never-orphan tests                                                                  |
| **PX-W13** ⚑ | **Passthrough request metadata** (G28): client records with presentation and reserved-name check, the request handle, `deviceLabel` from the SDKs (wire), consent data                                                     | S-16 I-04        | M    | **Plan mode** (SDKs send `deviceLabel`); corpus and transcripts; THREAT-MODEL (spoofed app names)                                        |
| **PX-W14**   | **Approve a new device** (G29) on the I-02 store                                                                                                                                                                           | S-16 I-02        | M    | Rule 10; THREAT-MODEL (phishing)                                                                                                         |

### 11.3 Phase B: features on the new API, S-16 and S-17

| ID        | Work package                                                                                                                                                                                                                    | Deps                                  | Size | Extra gates                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- | ------------------------------------------------------------ |
| **PX-08** | **Library on `GET /api/library`:** real art, seat meters, store-aware quick actions, server reasons, Discover count in the nav                                                                                                  | PX-02, PX-W1                          | S    | CSP test with real images                                    |
| **PX-09** | **Get it, complete** (server detection, Change platform, Extras, Also yours on, phone actions, Email me the download, public link-out, R2)                                                                                      | PX-04, PX-W2, PX-W3, PX-W7            | M    | Platform-grouping tests                                      |
| **PX-10** | **Focused flows:** free-device and download                                                                                                                                                                                     | PX-04, PX-W1                          | M    | Return-URL allowlist tests                                   |
| **PX-11** | **Package access**                                                                                                                                                                                                              | PX-04, F-21, G14                      | M    | Non-dismissable dialog test                                  |
| **PX-12** | **Login card v2:** identifier-first with `UsualMethodHint` (G30), code entry, passkey button and conditional UI, Apple/Google/Steam per product, license-key path, `AccountUpgrade` skippable and forced with the entries meter | PX-05, PX-W4, PX-W9, I-14, I-12, I-20 | M    | WebAuthn mocks; forced-upgrade test; no-enumeration test     |
| **PX-13** | **Account v2:** `SignInMethods` (connect, disconnect with step-up, last-method guard, Hide My Email notice), connected products, sessions, export; product identity card                                                        | PX-07, PX-W12, I-15                   | M    | Last-method test; step-up test; I-15 contract tests          |
| **PX-14** | **Passthrough card header:** `CardHeader` app and device variants, `AppConsent`, return screen, across broker, native redirect, issuer and device code                                                                          | PX-12, PX-W13, I-13, I-16             | M    | Header persists through every step (e2e); reserved-name test |
| **PX-15** | **After sign-in:** `AddMethodNudge`, `LinkAccounts`, `DeviceApproval` (both sides)                                                                                                                                              | PX-12, PX-W12, PX-W14                 | M    | Join requires both proofs (e2e)                              |
| **PX-16** | **Discover page:** `DiscoverTile`, add, just-added state, empty; teaser on the empty library                                                                                                                                    | PX-08, PX-W10                         | S    | Add mints once (double-click test)                           |
| **PX-17** | **Activate confirm step and deep link from apps:** art confirm (G22), entries notice, `product=` context                                                                                                                        | PX-06, PX-W5, PX-W8                   | S    | Error-state tests for all §4.19 cases                        |
| **PX-18** | **Cloud Sync section:** `CloudSyncCard` on the product page, TOC entry, ⌘K action, export and delete; absent everywhere for products without the service                                                                        | PX-04, PX-W11                         | M    | Test: no sync UI when `services.cloudSync` is off            |
| **PX-19** | **Docs:** rewrite `users/portal.md` and `services/identity/portal.md` (naming, Library/Discover, Activate, sign-in methods, Cloud Sync), developer guidance for listing art and app branding data; mark ADMIN.md superseded     | PX-09, PX-14                          | S    | `check:links`; docs drift gates if routes are documented     |
| **PX-20** | **Quality bar:** Playwright e2e over all §4 states in both themes at 1440 and 390 px, axe on every state, CSP browser test, visual baseline, horizontal-scroll assertion                                                        | rolling                               | M    | Runs in CI                                                   |

### 11.4 Order

```
PX-01 ─┬─ PX-02 ─┬─ PX-03
       │         └─ PX-08 ── PX-16 (needs W10)
       ├─ PX-04 ──┬─ PX-09 (needs W2, W3, W7)
       │          └─ PX-18 (needs W11 ← S-17)
       ├─ PX-05 ── PX-12 ─┬─ PX-14 (needs W13, I-13, I-16)
       │                  └─ PX-15 (needs W12, W14)
       ├─ PX-06 ── PX-17 (needs W5, W8)
       └─ PX-07 ── PX-13 (needs W12, I-15)
PX-W1 ─┬─ PX-W2 ── PX-W3 ⚑
       ├─ PX-W5, PX-W6, PX-W10
PX-W8 ⚑, PX-W9 ⚑, PX-W13 ⚑ with S-16 I-04 (one contract plan)
PX-W11 after S-17 · PX-W12 after I-06/I-14/I-15 · PX-W14 after I-02
```

Phase A (PX-01 to PX-07) and PX-W1/PX-W2 can run in parallel lanes. The first shippable cut is
**Phase A + PX-W1 + PX-08**: the new Library with real art, seats and statuses, the Activate modal,
on today's auth. Discover (PX-W10, PX-16) is the next cut and needs no S-16 work.

## 12. Open questions for the owner

1. **Q-1 · G14 path.** Fix F-20 to `/api/…` and a `#/p/<product>/package` login URL, or add a
   `/portal` alias? _Recommended: fix the plan; no alias._
2. **Q-2 · Hero art field.** `ManifestListing.headerUrl` as the banner, or a dedicated 16:9
   `heroUrl`? _Recommended: `headerUrl`, documented as 16:9 with a safe bottom-right corner._
3. **Q-3 · Phone default view.** List by default above 6 products on phones? _Recommended: yes._
4. **Q-4 · Media proxy storage.** R2 or KV? _Recommended: R2, content-addressed._
5. **Q-5 · Out of entries while signed in.** A key with no entries left can still be added by a
   signed-in account (that is the upgrade the decision asks for), so the modal shows a warning, not
   a block (§4.19). _Recommended: as drawn._
6. **Q-6 · Discover reasons.** Show the reason line ("For everyone with a fennick.studio email")
   on every offer, or let a product hide it? _Recommended: always shown; it explains why the offer
   exists and why it may go away._
7. **Q-7 · App consent frequency.** Show the confirm step on every first sign-in to an app and
   when what it gets changes (as drawn), or only for third-party web apps? _Recommended: as drawn._

---

## Appendix A · Mockup inventory

All files are in [portal/](portal/) as `NN-name-{desktop|mobile}-{dark|light}.png` (1440 px and
390 px wide, full page except dialogs). PNGs are palette-quantised (128 colours) for the repo.

| NN  | Screen                                             | §    |
| --- | -------------------------------------------------- | ---- |
| 01  | Login card, no context, passkey autofill           | 4.1  |
| 02  | Login card with product context                    | 4.2  |
| 03  | Known account: "You usually sign in with Steam"    | 4.3  |
| 04  | Enter the code                                     | 4.4  |
| 05  | Use a license key                                  | 4.5  |
| 06  | Key entry: account upgrade, skippable              | 4.6  |
| 07  | Key entry: account upgrade, forced                 | 4.6  |
| 08  | App sign-in: web app, method choice                | 4.7  |
| 09  | App sign-in: iPhone app, known Steam account       | 4.8  |
| 10  | App sign-in: native app, code                      | 4.8  |
| 11  | App sign-in: native app, create account            | 4.8  |
| 12  | App sign-in: native app, confirm                   | 4.8  |
| 13  | App sign-in: native app, return to the app         | 4.8  |
| 14  | App sign-in: device code, method choice            | 4.9  |
| 15  | App sign-in: device code, TV signed in             | 4.9  |
| 16  | Add another way to sign in                         | 4.10 |
| 17  | Link an existing account: join                     | 4.11 |
| 18  | Library, empty, with Discover teaser               | 4.12 |
| 19  | Library, one product                               | 4.13 |
| 20  | Library, three products                            | 4.14 |
| 21  | Library, twelve products, grid                     | 4.15 |
| 22  | Library, twelve products, list                     | 4.15 |
| 23  | Discover, four offers                              | 4.16 |
| 24  | Discover, just added                               | 4.16 |
| 25  | Discover, nothing to add                           | 4.16 |
| 26  | Activate license: enter key                        | 4.17 |
| 27  | Activate license: confirm                          | 4.17 |
| 28  | Activate license: done                             | 4.17 |
| 29  | Activate license: error states                     | 4.19 |
| 30  | Activate license: deep link, key prefilled         | 4.18 |
| 31  | Product page with Cloud Sync                       | 4.20 |
| 32  | Product page without Cloud Sync                    | 4.20 |
| 33  | Package token created                              | 4.21 |
| 34  | Remove a device, inline confirmation               | 4.22 |
| 35  | Device limit, focused flow                         | 4.25 |
| 36  | Account: sign-in methods                           | 4.26 |
| 37  | Account: disconnect with step-up                   | 4.26 |
| 38  | Account: last-method guard (Hide My Email account) | 4.26 |
| 39  | Sign in with another device: QR and code           | 4.23 |
| 40  | Approve a new device                               | 4.24 |
| 41  | Jump to a product (⌘K)                             | 4.27 |
| 42  | Product not in your library                        | 4.28 |

The mockups are static HTML/CSS with `@polaris-key/brand` `tokens.css` and the kit's Rubik files
inlined; developer key art is stand-in SVG and the QR code is decorative. They were generated and
rendered with Playwright from a scratch build script outside the repo; they are references for
layout, hierarchy and copy, not pixel specifications. Where this document and a mockup disagree,
this document wins.

## Appendix B · Fixed from the three-direction critique (kept)

- 12 identical solid violet buttons → outlined quick actions; solid only for hero, shelf, product
  header.
- No fallback for missing art → `ProductArt` tint field with icon or letter.
- Status chip over the Orbit Survey title → art text kept clear of the bottom-right corner.
- Glyphsmith title clipped → art fully inside the 16:9 frame.
- One Apple glyph for macOS and iOS → macOS uses the Apple glyph, iPhone & iPad a phone glyph, the
  web a globe.
- App Store action with a download icon → the App Store glyph.

## Appendix C · Owner decisions applied (2026-10-04)

| #   | Decision                                                                                                                                                                | Where                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Proto-Steam framing; top-level nav is Library (default) and Discover only; Cloud Sync is not a page                                                                     | §0, §3.2, §3.3                              |
| 2   | Discover: eligible products evaluated without issuing; Add to library mints like auto-issue                                                                             | §4.16, G24, G25                             |
| 3   | Activate license: right-aligned header action; always a modal; confirm step; inline errors; `/activate?key=`                                                            | §3.2, §4.17–4.19, G22                       |
| 4   | Legacy keys: limited entries; skippable then forced upgrade; apps refuse and deep-link; installs unaffected                                                             | §4.6, §4.18, G21, G15                       |
| 5   | Cloud Sync is its own service; only a product-page section, only when on; nothing anywhere otherwise                                                                    | §4.20, G26, S-17                            |
| 6   | "Polaris Key", never "Polaris Key Portal"                                                                                                                               | Naming, §6.1                                |
| 7   | One storefront-style login card; identifier-first; passkeys; Apple, Google, Steam only; no Discord                                                                      | §4.1–4.5, §6.1                              |
| 8   | App passthrough: persistent card header through every step, confirm and return; data-only branding                                                                      | §4.7–4.9, G28                               |
| 9   | Account linking: sign-in methods connect/disconnect with step-up, last-method guard, nudge, join with proof of both, approve another device, Steam web login everywhere | §4.10, §4.11, §4.23, §4.24, §4.26, G27, G29 |
| 10  | Keep the critique fixes and the library, shelf, product TOC, device-limit flow, package card and ⌘K                                                                     | Appendix B, §4.13–4.15, §4.20–4.27          |
