# Polaris Locker (the customer portal): current state

This document records the customer portal that ships in `packages/admin/src/portal/`. It is not an implementation plan. The code, the Worker responses it consumes, and the tests are the source of truth; a feature is described here only when the portal renders it today.

[EXPERIENCE.md](EXPERIENCE.md) is the shared visual and interaction contract. [SIGN-IN.md](SIGN-IN.md) is canonical for sign-in semantics across the portal, Worker pages, and SDK kits. This document records how those contracts are implemented by the customer portal, including supported fallbacks when a Worker has not yet provided optional data.

## 1. Purpose and boundary

The portal is the signed-in customer surface, which customers know as **Polaris Locker**, then **Locker** (D8). Until the Worker's `customer.host` switch turns on it is served at `key.plrs.im`, then at `polaris.locker`. "Portal" is the internal word only (route kinds, `handlePortal`, `portal_*` tables, this file's name); no customer-facing string says "portal" or "customer portal". Developer-facing words say Polaris Locker too (LK-00 §14.1). Words and copy rules: [concepts](../../packages/docs/src/content/docs/start/concepts.md). A person can inspect the products in their library, get a build or a store link, manage the devices and licenses attached to a product, add an eligible product or a license key, and manage their account.

It is distinct from the operator console. The portal has no product administration, provider configuration, catalog editing, or platform permissions. Product records and license policy are decided by the Worker; the portal presents the data and sends the person to the supported mutation endpoint.

The application starts in `portal/App.tsx`. A `ThemeProvider`, an isolated TanStack Query client, toast host, and live announcer surround the portal. `GET /api/me` decides whether the signed-in shell or the sign-in card renders. A 401 from another portal request rechecks that session rather than treating a transient request failure as sign-out. When the session ends, account-scoped queries are removed before the sign-in card replaces the shell.

## 2. Navigation and routing

The signed-in application uses hash routes. Product identifiers are product slugs.

| Route                                                           | Shipped destination                                 |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `#/`                                                            | Library, the default route                          |
| `#/discover`                                                    | Discover, when the Worker supplies a discover count |
| `#/discover/<product>`                                          | A storefront product that the account may add       |
| `#/p/<product>`                                                 | A product in the library                            |
| `#/p/<product>/{get,sync,new,license,devices,package,help}`     | A section of that product page                      |
| `#/p/<product>/{free-device,download}`                          | A minimal focused flow                              |
| `#/account/{profile,methods,products,sessions,appearance,data}` | Account; unavailable sections are not shown         |

Older `#/licenses`, `#/downloads`, `#/profile`, and `#/claim` forms canonicalize to their current home. Unknown hash routes canonicalize to the Library. `#/account/emails`, `#/account/passkeys`, and `#/account/linked` canonicalize to Account → Sign-in methods.

`/activate` is an entry path, not a separate page. Before first render it becomes the Library route with the Activate dialog open. A key may arrive in the URL fragment; legacy query-key links remain readable, but the key is removed from the address bar before render. The portal validates the optional product, next step, device label, and return value, keeps a carried key only in the current tab across sign-in, and never preserves a value that contains a key in a return parameter.

Page navigation uses the shared motion layer when motion is allowed. A page route starts at the top and focuses its `h1`; a section route scrolls to the named section. Reduced motion changes this to an instant change.

## 3. Signed-in shell

`PortalShell` provides a skip link, one banner, named main navigation, a main region, and footer. On desktop it shows Library, conditional Discover, the Activate license action, and the account menu. Discover appears only when `GET /api/library` returns `discoverCount`; this prevents a navigation link to an unavailable list.

On phones the fixed bar has Library, an outlined Activate license pill, and conditional Discover. The shell reserves room for that bar and positions phone toasts above it. The account menu contains the account destinations, appearance controls, Help, and sign-out.

The shell is responsive rather than a second mobile information architecture. At compact desktop widths the search trigger and account label give way before the navigation action; on a phone the same Activate dialog opens as a bottom sheet.

## 4. Shipped customer surfaces

### 4.1 Sign in

The signed-out portal renders one card in place rather than stacking dialogs. It has these shipped states:

- **Methods:** email address, Continue, product-specific provider buttons when the Worker advertises them, optional single sign-on, and the license-key on-ramp.
- **Code:** a six-cell email-code entry, automatic submission after the sixth digit, a resend countdown, and another-tab completion detection. An expired attempt returns to Methods with the address retained.
- **Refused:** a completed code for an account that cannot sign in ends in an explicit state with a route to use another email; it does not offer a misleading resend.
- **License key:** a paste-first key field. Continuing carries a valid key into the signed-in Activate dialog after sign-in.

The card fetches capabilities before it chooses product context or providers. It has explicit loading and unreachable states. The portal currently implements the email-code and advertised-provider entry points above; provider email confirmation, passkey enrollment and management, account linking, device-code sign-in, and the full app handoff flow belong to [SIGN-IN.md](SIGN-IN.md) but are not described here as shipped portal states unless the current route renders them.

### 4.2 Library

The Library is the default page and presents one item per product, not one per license. It explicitly handles loading, read failure with Retry, an empty library, a one-product hero, two to seven large tiles, and the scaled library at eight or more products. The scaled view supplies search, filters, sort, a persisted grid/list preference, an attention shelf, and a jump palette. Products added recently sort first where the scaled view can sort them.

Every library state retains the ways to add a key. An empty library may also show the Discover teaser only when the Worker has supplied a discover count. Quick actions are calculated from the Worker product, download, license, and device facts; the portal does not infer a download it has not received.

### 4.3 Discover and storefront products

Discover requests the products the account can add. Each tile exposes the Worker-provided reason, terms, art, and supported acquisition paths. Adding a product is an explicit mutation. On success the portal refreshes the library, license summaries, Discover, and the product record before moving on, so a following product route does not render a missing product.

A selected Discover tile opens a storefront product route. Unknown, ineligible, unlisted, and already-held storefront products share the deliberate not-found treatment rather than disclosing why a product is absent. A Worker that does not implement Discover returns the honest empty state and Discover stays out of the shell navigation.

### 4.4 Product pages and focused flows

A product route renders Worker-backed product information and the sections named in [§2](#2-navigation-and-routing): Get it, What’s new, License, Devices, conditional Package access, and Help. The `sync` route is reserved, but Cloud Sync has no portal data source and is not rendered. The page shows the product’s current presentation, license seats, devices, releases and downloads; optional panels remain absent rather than inventing a fallback record.

A lapsed license (updates ended) says so once, in the License card's term timeline. The downloads table has no **Not included** row for it, and **Renew** appears only in the License card. This is the owner's 2026-10-08 decision, built by PX-28.

The focused free-device and download routes use minimal chrome for an app or email return path. The free-device flow reads the selected license and devices, removes the requested device through the Worker, refreshes the product and library views, and validates its return target before following it. The download flow selects only a Worker-provided artifact and mints a fresh download URL when the person asks to download. PX-29 layout: the focused frame is one 640 px column, with the identity beside the task from 1024×900 and on a phone on its side (800×512), and a sticky action row under 761 px that stays in the flow on a short screen. The free-device heading is **Free a device**; focus lands on the heading on a cold load, and after an Activate claim focus moves to **Open** (or **Back to <product>** when an app sent the person) and the outcome is announced once.

### 4.5 Activate license

Activate is one dialog available from the signed-in shell and the Library’s key tile. It previews the key before claiming it, reports field and Worker errors inline, and only claims after confirmation. A successful claim refreshes library, license, release, and Discover data. A valid deep link can continue to the focused free-device flow when its validated `next` value requests it.

### 4.6 Account

Account is a single page with section navigation. It ships Profile, Sign-in methods, Appearance, Your data, and Where you’re signed in when the Worker exposes sessions. The page omits a section for which the API has no representation.

Profile reads and saves the display name and picture through the profile API. The session cache is updated immediately after a successful profile change so the header and account menu agree with the page. Sign-in methods, when supplied by the Worker, use the Worker’s step-up and last-method rules; a refused or stale operation causes the methods query to refresh. Sessions can end another session or sign out everywhere. Appearance stores the theme and motion preferences locally. Account deletion requires a typed confirmation and schedules an erasure 14 days out; the session stays, a notice under the header on every page says so with a Cancel deletion link, and a stale sign-in shows the step-up prompt in place of the refusal. Download my data and each product's Your data card (Download, Remove, Support code) do the same.

## 5. Data, writes, and freshness

The portal data layer is `portal/data.ts`. All portal query keys begin with `portal`; reads do not silently retry, refetch on window focus, and use a 30-second default stale time. Optional APIs that return 404 become an explicit absence only where the UI has a defined absence state, such as Discover, profile editing, methods, sessions, downloads, and package access.

| Customer action                | Worker result that the portal refreshes                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Add from Discover              | Library, Discover, license summaries, product record                                       |
| Remove an open library entry   | Library, Discover; product and storefront caches are removed                               |
| Claim a license key            | Library, license summaries, releases, Discover                                             |
| Remove a device                | License detail, license summaries, Library, product record                                 |
| Remove a license               | License detail is removed; license summaries, Library, product, releases, Discover refresh |
| Save profile                   | Profile and session account data are updated; stale profile errors refresh Profile         |
| Change sign-in method          | Methods, session, Profile, Library, license summaries refresh                              |
| Schedule or cancel deletion    | The session account refreshes (the shell notice and Your data follow it)                   |
| Download my data               | Nothing: the file is read-only                                                             |
| Remove my data from a product  | License detail, license summaries, Library, product, releases, Discover refresh            |
| Get a support code             | The product record refreshes                                                               |
| End a session                  | Sessions refresh when the mutation settles                                                 |
| Mint or revoke a package token | That product-and-license token list refreshes                                              |

Mutations do not retry automatically. A 401 rechecks `GET /api/me`; a deliberate account deletion uses the quiet-sign-out path. The CSRF token comes from the newest accepted session read, preventing an older in-flight session response from replacing a token issued after step-up.

## 6. Accessibility, failure, and motion

The portal uses semantic page landmarks, a skip link, named navigation, focusable page headings, live announcements, and labels for icon-only controls. Dialogs and menus return focus to their opener; route focus waits for a closing overlay and for a real page heading rather than focusing a loading placeholder. Error panels explain a failed read and offer Retry; loading views retain the destination’s structure instead of replacing it with a generic spinner.

Both colour schemes use the shared theme provider. The Appearance page exposes system, light, and dark preferences, plus system or reduced motion. Page transitions, list transitions, scrolling and first-load stagger effects respect reduced motion. Portal state changes remain understandable without colour alone through text, labels, and icons.

## 7. Parked and conditional work

The following are intentionally not presented above as shipped portal functionality:

- Account linking, provider email-gate completion, passkey enrollment and management, device-code sign-in, and app handoff completion are specified in [SIGN-IN.md](SIGN-IN.md) but require their corresponding Worker and portal work before they are shipped together.
- Connected products and data export are absent from Account until their APIs exist.
- Cloud Sync is parked: the route name is reserved but the product page has no Cloud Sync data source or rendered section. Package access, per-product downloads, Discover, profile editing, methods, and sessions are conditional on their Worker responses; their portal homes either render the received data or stay absent as described above.
- The supplemental portal studies and historical PX work-package tables are research coverage, not a shipped-surface inventory. They must not be used to infer navigation, permissions, data fields, or customer actions that the current portal has not implemented.

## 8. Source map

- App composition and signed-in/signed-out boundary: `packages/admin/src/portal/App.tsx`
- Canonical routes, legacy redirects, focus, and deep-link sanitisation: `packages/admin/src/portal/router.ts`
- Server client, queries, mutations, and cache invalidation: `packages/admin/src/portal/api.ts` and `packages/admin/src/portal/data.ts`
- Shell, sign-in card, page components, and focused flows: `packages/admin/src/portal/components/` and `packages/admin/src/portal/pages/`
- Portal API route and handler composition: `packages/worker/src/console/routes.ts` and `packages/worker/src/console/`
