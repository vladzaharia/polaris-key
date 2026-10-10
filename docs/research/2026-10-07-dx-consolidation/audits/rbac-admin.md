# Audit: console RBAC, console access through accounts, platform settings and console IA

> DX consolidation, 2026-10-07. Domain: who may use the console and what they may do there; how an
> operator signs in; the Platform settings area; the console's Platform and Product navigation.
> Read against the tree at `pk-wt/dx-plan` (v0.8.31 plus batch 5, `38d3acc68`), the in-flight
> branches LX-08, HA-10, HA-12, UK-13 and UK-14 (none of which touches admin authorization), the
> owner brief (`../owner-brief.md`), the program backlog (`docs/research/2026-09-29-godot-omniplatform/program/`),
> the design specs (`docs/design/*.md`), notes S-13, S-16 and S-18, and `docs/security/THREAT-MODEL.md`.
> Paths are repo-relative. Research only: no code was changed.

---

## 1. Summary

**State.** The console has exactly one privilege level. `PLATFORM_ADMIN_GROUP`, read from the
`groups` claim of the console's OIDC client (Pocket ID), is the login gate, the product gate and the
platform gate at once (`packages/worker/src/admin/authz.ts:1-44`). A session either carries full
platform authority or is never issued (`admin/session.ts:1-6`). There is no operator account, no
role, no per-product access, no read-only state, no "no access" page and no `useCan`, even though
ADMIN.md §5.10, EXPERIENCE O9, SETUP §1.11 and FLOWS C16 are all written as if `useCan` existed.
Operators and customers live in different realms on the same origin: customers have Polaris Key
accounts (I-05, revocable `account_sessions`, passkeys, linked providers), while operators have a
stateless 8-hour HMAC cookie carrying Pocket ID's `sub` and `groups`. The Platform settings page
is one 11,316 px column (S-18 §2.6 item 7). Several registered platform settings have no section on
it. The product "Admin group" field is shown and edited but grants nothing.

**The single most important change.** Make the operator an account and authorize every console
request through one permission engine, `can(member, scope, area, level)`. The engine evaluates
**built-in roles** (Superadmin, Platform admin, Product admin, Product editor, Product viewer, Console
access), bound to members directly or through **SSO rules** on the claims of their linked
providers. Today's `PLATFORM_ADMIN_GROUP` becomes the non-removable, deploy-time **root rule**
("members of that group at the console IdP are Superadmins"), so the upgrade needs no
configuration and cannot lock anyone out. This replaces ST-21 (a settings-only capability gate) and
ST-22 (optional per-product roles) with one RBAC package set, RB-01 to RB-08. RB-01 is plan mode
because it changes the authorization model. **No wire change:** the admin API is narrative-only
and the console cookie is not a signed document.

**Surface shrinks.** The changes remove one knob that does nothing (`adminGroup` in the manifest,
the registry and the console), ad-hoc `isPlatformAdmin` re-checks in about 12 handlers, and two
session realms with two identities per operator. "Ask a platform admin" and UX-51's setup requests
become one Requests concept. One Platform sidebar context replaces the "platform links plus a
Platform group" construction. The Platform settings page is reordered by how often each setting
changes and split into sub-pages. The settings that widen what a stolen session can do stay
deploy-time (AT-2). Role grants are not settings: they get their own controls (step-up,
notification, no escalation, a deploy-time root).

---

## 2. Current state (with file references)

### 2.1 Console sign-in

- `GET /manage/login` starts PKCE against `adminOidcConfig(env)`: the console's own client
  (`ADMIN_OIDC_*`, I-03) when both issuer and client id are set, else the platform client
  (`PLATFORM_OIDC_*`) (`packages/worker/src/platformOidc.ts:40-52`, `admin/auth.ts:235-293`). The
  scope is `openid email profile groups` (`auth.ts:278`).
- `GET /manage/callback` verifies the ID token (nonce, issuer, audience; `auth.ts:162-204`), maps
  `sub`, `email`, `name`, `groups` and `auth_time` (`auth.ts:139-160`), then gates on
  `hasAnyAdminGrant(env, identity.groups)` (`auth.ts:331-338`). A non-admin gets a server-rendered
  403, "Your account is not an administrator of any product.", with no way forward.
- **The session** is an HMAC cookie `__Host-pkey_admin` with an 8-hour TTL. It is stateless and
  cannot be revoked short of rotating `ADMIN_SESSION_SECRET` (`admin/session.ts:44-51,121-131`).
  It carries `sub`, `name`, `email`, **`groups`**, `csrf`, `exp` and `authAt` (`session.ts:55-71`).
  Grants are frozen into the cookie for 8 hours.
- **Step-up** exists. `isSteppedUp` requires a sign-in no older than 5 minutes
  (`session.ts:73-83`), and `?stepUp=1` forces `prompt=login`/`max_age=0` (`auth.ts:283-288`).
  It is used by I-12's relink, per-subject deletion (`admin/handlers/users.ts:234,281,442`) and
  the override-migration run (`handlers/overrideMigration.ts:282`).
- **The docs site** is gated on "a session exists", which is valid only because every session is
  a platform admin (`packages/worker/src/docs.ts:1-11`).

### 2.2 Authorization

- `isPlatformAdmin`, `canAdminProduct` and `hasAnyAdminGrant` are one predicate under three names
  (`admin/authz.ts:19-44`). The file's own comment says that per-product admin "does not exist and
  is not planned".
- The dispatcher checks the session, the 600/min per-subject limiter and CSRF
  (`admin/api.ts:382-423`), then routes `/me`, `/summary`, `/platform/*`, `/github`, `/products/*`.
  Product-scoped routes are gated once, at `canAdminProduct` (`api.ts:110-144`), with a
  rate-budgeted `access.denied` audit row. Platform routes are gated inside each handler, so there
  are about 12 scattered checks. Some product-scoped handlers re-check platform admin after the
  dispatcher already has: `handlers/trustPolicy.ts:62`, `outletCredentials.ts:80`,
  `ciPublishing.ts:122,153`, plus `summary.ts:32`, `products.ts:169`, `platform.ts:205`,
  `github.ts:171`, `platformStoreConnections.ts:178`, `me.ts:36`.
- `/me` returns `platformAdmin: boolean` and `products` (all, or none) (`handlers/me.ts:30-66`). The
  console reads `platformAdmin` in exactly one place, `pages/license/OverrideMigrationNotice.tsx:59`.
  **There is no `useCan` anywhere in `packages/`** (grep), and nothing renders a read-only state.
- **Settings registry capability.** Every `SettingDef` carries
  `capability: settings.<scope>.<owner>.write` (`core/settings/types.ts:239-240`, defaulted in
  `core/settings/define.ts:21`, shape-checked in `core/settings/rules.ts:415-416`). **Nothing reads
  it.** `writeSetting()` (`core/settings/write.ts`) has no authorization step.
- **The AT-2 deny-list** refuses any platform setting that names "the privilege root"
  (`/admin|group/`, `roles?`), the admin IdP, a security gate, key material, session lengths, rate
  limits, retention or buckets (`core/settings/rules.ts:93-116`). It rests on S-13 §8.2's argument
  that a runtime-editable admin group would make a stolen session permanent.

### 2.3 The per-product "Admin group"

- `products.admin_group` is registered as `core.adminGroup`: manifest-only, `securityWidening`,
  `critical`, area `access` (`core/settings/core.ts:64-85`; listed in `SECURITY_WIDENING_KEYS`,
  `rules.ts:138-140`). The manifest field `product.adminGroup` feeds it.
- The console shows it in Core → Settings → General. On unlinked products it is an editable input
  with the help text "Metadata only. It grants nothing" (`pages/core/Settings.tsx:312-336`). The
  docs explain at length why setting it does nothing (`packages/docs/src/content/docs/admin/products.md:141-147`).
  `api.ts` is listed as a reader (`core.ts:83`) but only mentions it in a comment.
- THREAT-MODEL still says console access is "`PLATFORM_ADMIN_GROUP` (or a product admin group)"
  (`docs/security/THREAT-MODEL.md:5139`), which is wrong.

### 2.4 Accounts (the customer realm, reusable for operators)

- `accounts`, `account_links` (issuer, subject, kind, `amr_json`), `account_sessions` (revocable,
  `amr_json`) and pairwise subjects (`packages/worker/migrations/0068_a_accounts.sql`). The global
  account id never leaves Identity and Core (I-05 rule, same file's header).
- `account_links.groups_json` already stores the `groups` claim each OIDC sign-in asserted
  (`migrations/0071_portal_discover.sql:26`; `services/identity/portal/repo.ts:290-301`), for
  Discover's `groupRoleMap` evaluation (PX-W10).
- Passkeys on `key.plrs.im` (I-16), step-up (`portal/link.ts:223`), and the login card with
  Google, Apple and Steam (I-06, I-07).
- **Pocket ID** (`id.plrs.im`) issues public subjects, so the console client and the platform
  client see the same `sub` for one person (S-16 §3.1). After I-17 it is operator-only.
- **Decision record.** S-16 §5.6 and decision 3 (`notes/S-16-identity-service.md:1185-1187,1404-1405`)
  say that console operator sign-in is "out of the service: Pocket ID, `PLATFORM_ADMIN_GROUP`, one
  admin level". The owner brief now reverses the identity half of that.

### 2.5 Console information architecture

- `packages/admin/src/console/nav.ts` declares every page once for the sidebar, router, top bar and
  palette. Product sections are Core plus one per enabled service. The Platform pages are Settings,
  Deployment, Operations, Store connections, Package feeds and **Override migration**
  (`nav.ts:750-829`; the migration page sits at `nav.ts:813-826`).
- **The sidebar** always draws Home and Products first. The "Platform" collapsible group follows,
  **only off a product** (owner, 2026-10-04). Inside a product, the product's sections follow
  instead (`console/shell/Sidebar.tsx:84-98,124-181`). The Platform/Product context switch the
  owner asks for therefore mostly exists. What remains is a context header, Home and Products
  leaving the product context, and the Platform group losing its pointless collapse.
- **Platform → Settings** (`console/pages/platformSettings.tsx`, 2,089 lines) is one page. Its
  render order is warnings, Background jobs, Licensing, Identity & access, Delivery, Email, Limits,
  Keyring, Secrets, History (`platformSettings.tsx:290-470`). It filters the registry by area
  (`:332`, `:338`, `:387`, `:1049`), so the registered areas `product-defaults` and `storefront`
  have **no section**. The platform switch `storefront.polarisKey.enabled`
  (`core/settings/platform.ts:310`) is shown only read-only in PS-06's panel (`admin/src/api.ts:1522`).
  The platform asset quotas wait on HA-10, which is in review. Four more keys are `pending` on
  ST-16 or PX-W13b.
- **Inventory.** 79 deploy-time names (`platformInventory.generated.ts`) are shown read-only. The
  platform slice registers 16 keys, of which 4 are still `pending`.
- **No access state.** `shell/StatePages.tsx` has NotFound, UnknownProduct, ServiceOff and Boot,
  and no "you don't have access" page.

### 2.6 Planned work that touches this domain

- **ST-21** (todo, 0.5–0.7 wk): `can()` on settings writes and `useCan`. "Today's admin group
  remains the only role."
- **ST-22** (todo, optional, plan mode, 1.2–1.7 wk): per-product operator roles "after a security
  review".
- **ST-05/07/08/09/10/16/27**: the settings API, row, hubs, search, defaults and alerts.
- **Shell and sign-in UX:** UX-02 (session states), UX-13 (chrome), UX-42 (identifier-first console
  card), UX-30 (Status = Deployment + Operations), UX-51 (setup state with `requests_json`), UX-67
  (Platform ready) and UX-12 (attention). All are todo.
- **Dependants of `can()`:** CM-03 ("product-owner capability only (ST-21)",
  `program/wp/CM-03-merchants.md:56`), UX-36 (bulk license actions), SETUP D12/D34 and FLOWS
  F16/C16 ("Ask a platform admin").

---

## 3. Problems (ranked)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                                           | Impact      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- |
| 1   | **All-or-nothing access.** Anyone who needs to look at one product's releases must be given every product, every secret, every store credential and the platform keyring. There is no read-only, support or per-product role, and no way to remove one person without changing IdP group membership.                                                    | `admin/authz.ts:1-44`; `session.ts:1-6`                                            | high        |
| 2   | **Operator identity is a separate realm.** It is a stateless 8-hour cookie with `groups` frozen in it: removing someone from the IdP group takes up to 8 hours, and a stolen cookie cannot be revoked. Operators have two identities: Pocket ID for the console and an account for their own licences and Library. Console sign-in dies with Pocket ID. | `session.ts:44-71`; S-16 §5.6                                                      | high        |
| 3   | **`useCan` is specified but does not exist, so four designs depend on a fiction.** ADMIN.md §5.10 says "every write control reads it". EXPERIENCE O9, SETUP §1.11/D12/D34, FLOWS F16/C16 and UX-36 build on it. CM-03 cites a "product-owner capability" that no plan defines.                                                                          | grep `useCan` in `packages/`: 0 hits; `docs/design/ADMIN.md:971-990`               | high        |
| 4   | **Authorization is scattered.** About 12 ad-hoc `isPlatformAdmin` checks, some duplicating the dispatcher's. The settings registry's `capability` field is declared on every entry and never enforced. A new route has no deny-by-default.                                                                                                              | §2.2 call sites; `core/settings/types.ts:239-240`                                  | high        |
| 5   | **A knob that does nothing.** `adminGroup` is in the manifest, the registry (as `securityWidening` and `critical`), the console (as an editable input) and a docs paragraph explaining that it does nothing. It invites operators to believe it grants access.                                                                                          | `core/settings/core.ts:64-85`; `Settings.tsx:312-336`; `admin/products.md:141-147` | medium      |
| 6   | **No "no access" path.** A non-admin is stopped at the callback with an HTML 403 that offers nothing. There is no request flow and no in-app forbidden page. "Ask a platform admin" exists only in specs, and differently in each (SETUP D12 copies a link and adds an attention item; FLOWS F16 adds a "setup request").                               | `auth.ts:331-338`; `StatePages.tsx`                                                | medium      |
| 7   | **The Platform settings page is long and not ordered by use.** It is 11,316 px tall on a phone, with no rail and no collapsing. Background jobs (rarely changed) come first, and product defaults (the most product-affecting) have no section. Registered keys are unreachable in the console.                                                         | S-18 §2.6 item 7; `platformSettings.tsx:290-470`; `platform.ts:284-460`            | medium      |
| 8   | **Two platform navigation constructions.** The Platform group is collapsible though it is the only group in its context. Home and Products stay in the product context. A one-time migration page (Override migration) is a permanent sidebar item.                                                                                                     | `Sidebar.tsx:124-160`; `nav.ts:813-826`                                            | low         |
| 9   | **Doc and threat-model drift.** THREAT-MODEL:5139 ("or a product admin group"). `api.ts` is listed as an `adminGroup` reader. The S-18 D10 and S-13 §8.1 texts assume no roles ever.                                                                                                                                                                    | as cited                                                                           | low         |
| 10  | **No admin automation identity.** There is no personal or role-scoped API token for the admin API (CI tokens are per product, for publishing only).                                                                                                                                                                                                     | `handlers/ciPublishing.ts`                                                         | low (defer) |

---

## 4. Owner brief: item-by-item stance

| Owner item                                                                                                               | Stance                            | Reasoning and what we do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform settings "expanded to include the things that are configurable"                                                 | **Adapt**                         | Every registered platform key gets a home (ST-09, ST-11, ST-12, ST-16, ST-27). Things AT-2 keeps deploy-time (origins, the admin IdP, KEK, session lengths, rate limits, retention, the issuer allowlist) stay deploy-time. They are shown as **presence plus the exact setup command**, never as editable fields. "Configurable" means configurable without widening what a stolen session can do.                                                                                                                             |
| "Laid out intelligently, with commonly changed settings above others"                                                    | **Adopt**                         | The page splits into sub-pages ordered by change frequency: Product defaults, Sign-in and accounts, Storefront and hosting, Email and alerts, Licensing, Background jobs, then a collapsed read-only Advanced section. A "Recently changed" strip from `platform_audit` sits on top, with `@modified` in search (§5.6).                                                                                                                                                                                                         |
| Switch between the "Platform" sidebar and the "Product" sidebar by context                                               | **Adopt (mostly built)**          | Since 2026-10-04 the Platform group already shows only off a product. Two refinements: a context header at the top of the sidebar (Platform ⇄ product, the switcher's job), and Home and Products leave the product sidebar. The Platform context becomes a flat list. All of it is filtered by permission (§5.5).                                                                                                                                                                                                              |
| RBAC: user access to the console itself                                                                                  | **Adopt**                         | Console access = membership (a `console_members` row). Customers have none by default.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| RBAC: access to individual apps                                                                                          | **Adopt**                         | Product-scoped role bindings, for one product or **All products** (which includes future products). Product lists, summaries, the switcher, the palette and attention all filter by it.                                                                                                                                                                                                                                                                                                                                         |
| RBAC: access to platform settings                                                                                        | **Adopt**                         | The Platform admin role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| "Restrict features per-product or platform-wide"                                                                         | **Adapt**                         | Editor and Viewer bindings can be **narrowed to areas**, and an area is a sidebar section. Example: "Tonebox editor, Distribution only" is a storefront manager; "All products viewer, Release" is a release watcher. No deny rules and no custom permission matrices in v1. Disabling a _service_ platform-wide is a different thing (a settings policy, ST-16) and is deferred.                                                                                                                                               |
| OIDC mappings: a group gives console access, another gives an app's storefront settings, a claim gives the whole project | **Adapt**                         | **SSO rules**: when someone signs in with _provider_ and their _claim_ includes or equals _value_, they get _role_ at _scope_ (optionally narrowed to areas). Rules may only name issuers on the deploy-time allowlist. They are Superadmin-only, need step-up, and preview who matches before saving. They are evaluated on the claims stored at that provider's last sign-in. Supported claims: `groups`, a verified email domain, and one named claim per rule.                                                              |
| Administrators subject to RBAC                                                                                           | **Adopt**                         | Nothing bypasses `can()`. Superadmin is a role (a wildcard), not a code path.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| "Superadmin" (everything, current and new)                                                                               | **Adopt**                         | A wildcard over every scope and area, including future products and areas. Only Superadmins grant Superadmin or Platform admin, or edit SSO rules. **The root:** `PLATFORM_ADMIN_GROUP` at the console IdP is a non-removable, deploy-time rule granting Superadmin, so today's admins keep everything with zero configuration and a lockout is always recoverable by deploy.                                                                                                                                                   |
| "Platform Admin" (console plus Platform settings)                                                                        | **Adapt**                         | Edit on every platform area (Settings, Store connections, Package feeds, Status) plus creating and linking products. A Platform admin automatically becomes **Product admin of products they create**. **No implicit access to other products' contents** (they see names and service dots only). They may invite people (console access) but not grant platform roles. This is the owner's literal reading and keeps the platform/product split meaningful.                                                                    |
| "{Product} Admin" per product                                                                                            | **Adapt**                         | One parameterized role, **Product admin @ <product or All products>**, not one role object per product. Two presets come with it, **Product editor** (everything but Keys, Settings and Access) and **Product viewer** (read-only), because "storefront settings for one group" needs something below admin. In the UI it reads "Tonebox admin".                                                                                                                                                                                |
| "Console Access" as a role giving only console access, used with other roles                                             | **Adapt**                         | It is **membership**. Every other role implies it (sum of roles), so the common case is one mapping, not two. "Console access" stays a grantable role and a mappable rule target, for "let this group in, we'll grant later".                                                                                                                                                                                                                                                                                                   |
| A console-access-only user sees "contact an administrator", same as a forbidden page                                     | **Adopt and extend**              | One `NoAccessPage`. It names who can help (the scope's admins) and has **Request access**, which routes to those admins as an attention item and an email. The same component serves a member with no grants, a forbidden deep link and a disabled control's "Request access". Non-members see the sign-in card's "{email} doesn't have console access. Ask your administrator to invite {email}." with **Open your library**.                                                                                                  |
| Multiple roles = sum of access                                                                                           | **Adopt**                         | A union of (scope, area) → max(level). No negative grants.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| "Rivals GitHub"                                                                                                          | **Adapt**                         | Parity on what matters: members, email invites, built-in roles, IdP-group mapping (teams by SSO), product-level roles, audit, notifications, step-up ("sudo mode") and enforced SSO or passkeys for operators. **Deferred:** custom roles, team objects inside Polaris Key, fine-grained admin API tokens, IP allowlists and time-boxed grants.                                                                                                                                                                                 |
| Identity: "Console/Management accounts go through the same accounts system… associate permissions with the account"      | **Adopt, with conditions**        | The operator is an account. The console session is **derived from the account session**, which makes it revocable and lets one person hold both console access and their own licences. Conditions: console entry needs a **strong method**, a passkey or an SSO provider (never an email code or magic link alone, else step-up). The console keeps its own short cookie (8 hours, `__Host-pkey_admin`), bound to the account session id. Member ids (`mbr_…`) keep the global account id inside Identity and Core (I-05 rule). |
| "Customers who are not developers should not access the management portal"                                               | **Adopt**                         | No membership by default. Accounts never gain console access from being customers.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Access tokens: developers and administrators see SDK packages                                                            | **Adopt (cross-domain)**          | RBAC exposes `isConsoleMember(accountId)` through a Core hook. The feeds and tokens domain uses it to show the system product's SDK feeds to members.                                                                                                                                                                                                                                                                                                                                                                           |
| Simplified product card; mobile pips (Administration minor)                                                              | **Defer to the console-UX audit** | Not RBAC. Note: the merged Home + Products page (§5.5) is where the card lives, and it must filter by permission.                                                                                                                                                                                                                                                                                                                                                                                                               |

**Pushbacks, stated plainly:**

1. **Repo writers must not grant console access.** `product.adminGroup` must not become a role
   source. A push to `.pkey/` is not a console grant: the same reasoning as D21 for issuer clients
   and R9-01 for issuers. The field is retired, and RB-05 offers to convert a declared value into an
   SSO rule that a Superadmin confirms.
2. **The privilege root stays deploy-time** (AT-2, S-13 §8.2). Runtime grants sit _below_ it with
   controls that a stolen cookie cannot pass: step-up within 5 minutes, notification, no
   escalation, and SSO rules only on allowlisted issuers. AT-2 is amended, not abandoned.
3. **No deny rules and no custom role builder in v1.** Sum-of-roles with six built-ins and area
   narrowing covers every example in the brief. Custom roles return only with a concrete need.
4. **No email-only console sign-in.** A mailbox compromise must not become a console compromise.

---

## 5. Target design

### 5.1 Principals and membership

- **Account**: the Polaris Key account (I-05), unchanged.
- **Member**: `console_members(id 'mbr_…', account_id UNIQUE, status active|suspended, source
invite|rule|root|request|creator, created_by, created_at, last_console_at)`. A member has
  "Console access". The member id is what the admin API, audit and the Access pages show, so the
  global account id never leaves Identity and Core.
- **Invite**: `console_invites(id, email_norm, binding_json, token_hash, invited_by, expires_at
[7 days], accepted_member)`. It is accepted by signing in with that verified email and a strong
  method. Single use. Without email delivery, it falls back to a copyable link.

### 5.2 Roles, scopes, areas, levels

- **Scopes**: `platform`, `product:<slug>`, `products:*` (All products, including future ones).
  The system product (`polaris-key`) is platform scope (Platform → Package feeds), as today
  (`api.ts:166-170`).
- **Areas = sidebar sections**, so the permission taxonomy follows the IA automatically. If the
  release, distribution or commerce consolidation adds a section (Commerce, say), it becomes an
  area with no RBAC change.
  - Product areas: `core` (Overview, Devices, Users, Presentation, Activity) · one per service
    section (`license`, `config`, `release`, `distribution`, `update`, `identity`, `sync`) ·
    `keys` (Keys & secrets, CI publishing, outlet credentials) · `settings` (the settings hub's
    Core areas, Services, repository and resync, storage, danger zone) · `access`.
  - Platform areas: `platform.settings`, `platform.stores` (team store credentials, S-15 §8.1),
    `platform.feeds`, `platform.status`, `platform.products` (create, link), `platform.access`.
- **Levels**: `view`, `edit`. On top of these, **admin-only actions**, one rule listed once:
  everything in `keys`, `settings` and `access`; every `securityWidening` setting write
  (`core/settings/rules.ts:138-175`); I-12 relink and per-subject deletion; product deletion. A
  bulk Disable stays an editor action, guarded by its L2 confirm.

| Role               | Scope                                                 | Grants                                                                                                                                                    |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Superadmin**     | platform                                              | Everything, every scope, current and future; grants Superadmin and Platform admin; edits SSO rules                                                        |
| **Platform admin** | platform                                              | Edit on `platform.*` except granting platform roles and editing rules; sees product names and service dots; becomes Product admin of products they create |
| **Product admin**  | product or All products                               | Edit on every product area, including `keys`, `settings`, `access` and admin-only actions                                                                 |
| **Product editor** | product or All products, optionally narrowed to areas | Edit on `core` and service areas; view on `keys` (presence only) and `settings`                                                                           |
| **Product viewer** | product or All products, optionally narrowed to areas | View                                                                                                                                                      |
| **Console access** | platform                                              | Membership only (implied by every other role)                                                                                                             |

**Effective permission** = the union over direct bindings and matching SSO rules, taking the max
level per (scope, area). `products:*` grants apply to every product, including ones created later.

### 5.3 Grant rules (what makes runtime grants safe under AT-2)

1. Only Superadmins grant Superadmin or Platform admin, create or edit SSO rules, or change the
   area narrowing of an All-products grant.
2. A Product admin grants product roles on their product, including invites (which create
   membership). A Platform admin invites members (Console access) and removes members who hold
   nothing above Platform admin.
3. **No escalation:** nobody grants a level they do not hold at that scope.
4. **Every widening grant needs step-up** (an interactive sign-in no older than 5 minutes,
   `isSteppedUp`). The confirm is L1, or L2 typed for Superadmin, Platform admin, All-products or
   a rule. It emails the grantee and every Superadmin (and the ST-27 destinations once they exist),
   and writes `platform_audit` (`access.*`) plus the product `audit` for product grants. A revoke
   is L1 with Undo.
5. **The root rule** (`PLATFORM_ADMIN_GROUP` at the console IdP → Superadmin) is computed from
   `env`, shown read-only, and cannot be removed or shadowed. Recovery from any console mistake is
   a deploy.
6. **SSO rules** may name only issuers that pass the deploy-time `OIDC_ISSUER_ALLOWLIST` (or the
   console IdP itself). A stolen session can therefore never introduce a new identity provider.
7. Membership survives account merge only with re-approval. Account deletion or disable ends
   membership. A link change on a member's account always needs step-up and is emailed (the I-05
   rules, enforced for members regardless of product settings).

### 5.4 Sessions and the engine

- **Sign-in.** Console sign-in is the shared login card (UX-42 folded into RB-07): identifier-first,
  then Continue with the console IdP (Pocket ID) or **Sign in with a passkey**. Any account session
  whose AMR includes a passkey or an OIDC provider can **enter the console**. An email-only session
  is asked to step up. Until RB-07, the existing `/manage/callback` resolves the Pocket ID identity
  to an account through I-05 `signIn(verifiedIdentity)`. Pocket ID subjects are public, so this is
  the same link row the portal's single sign-on already writes, and the person gets one account.
- **Cookie.** `__Host-pkey_admin` stays (HMAC, 8 hours, CSRF double-submit). It carries `mid` and
  the account session's `sid` and **no `groups`**. Per request: the member is active, the account
  session is live (not revoked), and the effective permissions are computed. One indexed D1 read,
  cached for 30 seconds per isolate. A cached decision expires in 30 seconds, so a revoke takes
  effect within 30 seconds. Group-derived grants refresh at each sign-in to that provider (at most
  8 hours, as today).
- **`can()`**: one function in `admin/authz.ts`. Its signature is `can(perm, {scope, product?,
area, level})`. It replaces `isPlatformAdmin`, `canAdminProduct` and `hasAnyAdminGrant`.
- **Route-permission table.** `ADMIN_ROUTE_PERMISSIONS` maps (method, path pattern) → (scope, area,
  level), and the dispatcher enforces it before any handler. Service `adminHandle` routes inherit
  `area = <service>` and `level` from the method, with listed exceptions for admin-only actions. A
  test enumerates every admin route (the route-coverage inventory) and fails on any unmapped one:
  deny by default. The handler-level `isPlatformAdmin` re-checks are deleted.
- **Settings.** `writeSetting()` calls `can()` with the key's area (`SettingDef.capability` is
  replaced by the service or area it already encodes). `securityWidening` keys need Admin.
- **`/me`** returns `member` (id, name, email, avatar), `roles` (for the account menu chip) and
  `permissions` (a compact scope → area → level map). `platformAdmin` is kept for one release.
  `useCan(area, level, product?)` reads it. Every write control renders `disabledReason` plus
  **Request access**. Sections the member cannot view are hidden. Palette, attention and launch
  path filter by it (EXPERIENCE O9, now real).
- **Docs.** The `/docs` gate becomes "an active member" (`docs.ts`).

### 5.5 Console IA

- **Two sidebar contexts**, chosen by route.
  - **Platform**: Home (attention, Platform ready, product cards; the Products table becomes a
    view toggle on Home), Access, Settings, Store connections, Package feeds, Status (UX-30:
    Deployment and Operations merged) and Activity (UX-27's global page). A flat list with no
    collapsible group header.
  - **Product**: a context header at the top (product name, service dots, "Platform" back link;
    this is the product switcher's trigger), then Core and the enabled service sections as today.
  - Every item is filtered by `view` permission. A member with exactly one product and no
    platform role lands on that product.
- **Override migration** leaves the sidebar. While a migration is pending or in its 90-day report
  window, it is reached from an attention item and from Status, and the page is deleted after.
- **Access** (Platform):
  - **Members**: a table with each person, how they got access (Direct, via rule _name_, Deploy
    root), role chips ("Superadmin", "Tonebox admin", "All products · Viewer · Release"), last
    console sign-in, and ⋯ (Edit access, Sign out everywhere, Remove).
  - **Invite people**: a drawer with emails, role, scope, optional areas and a preview sentence
    ("Ada will be able to edit Distribution in Tonebox").
  - **SSO rules**: the read-only root rule first; **Add rule** is a T6 flow (provider → condition →
    role and scope → preview of the members whose last sign-in matches → L2 plus step-up).
  - **Requests**: approve, which opens the grant drawer prefilled, or decline.
  - **Roles**: a read-only role × area matrix, generated from code, with the same drift gate as
    the settings reference.
- **Product → Settings → Access** (an ST-08 hub area): the same table filtered to the product, with
  **Add people** (members or invites) and the product's rules (read-only unless Superadmin).
- **NoAccessPage** (`shell/StatePages.tsx`). Title: "You don't have access to {Tonebox → Licenses}
  yet". It shows "Signed in as {email}", "Who can help: {up to three admins of that scope}",
  **Request access** (the scope, area and level are inferred from the route), **Open your
  library** and **Use another account**. A member with no grants sees it as Home, titled "You're in.
  Ask an administrator for access".
- **Cross-links.** The console account menu gets "My library" (`/`) and the member's role chip. The
  portal account menu gets "Open console" for members only (via the Core `isConsoleMember` hook).

### 5.6 Platform → Settings, reordered

The route becomes `#/platform/settings/<area>`: a rail on desktop and a select on phone (ST-09).
Every registered platform key gets a row, and the page renders from the registry so no area is
dropped again.

1. **Recently changed**: the last five platform setting changes from `platform_audit`, each
   deep-linking to its row, with a search box. It is automatic and needs no curation.
2. **Platform ready** (UX-67), until complete, then a one-line "All set". RB adds a row: "Invite
   your team or map an IdP group".
3. **Product defaults**: licence defaults, the key-entry limit, hosting quotas and Cloud Sync
   ceilings, with "N products inherit · M override" (ST-16).
4. **Sign-in and accounts**: sign-in providers by presence (Google, Apple, Steam, Turnstile, email
   delivery) with the setup command each needs, reserved display names and terms, and the
   key-entry refusal switch. SSO connections live here when the identity domain adds them.
5. **Storefront and hosting**: the Polaris Key storefront switch, asset hosting and quotas, and
   the package feeds policy (moved here by ST-09).
6. **Email and alerts**: sender, Apple relay, daily cap (ST-11), alert destinations (ST-27).
7. **Licensing**: reserved entitlement names and the list of products that declare them.
8. **Background jobs**: the A-13 four.
9. **Advanced** (collapsed, read-only): deployment values, Limits (generated from code), Keyring,
   Secrets presence.
10. **History**: filtered platform audit.

The console OIDC client, `PLATFORM_ADMIN_GROUP` and the console sign-in methods are shown on
**Access → SSO rules** (the root rule card), not in Settings.

### 5.7 What does not change

- No wire, signed-document, client-core, corpus or `PROTOCOL_VERSION` change.
- CSRF, the per-subject limiter, the `access.denied` audit budget and the 8-hour console TTL stay.
- `PLATFORM_ADMIN_GROUP`, `ADMIN_OIDC_*` and `OIDC_ISSUER_ALLOWLIST` keep their names and meaning.
- I-12's step-up mechanism is reused as is.
- Product `groupRoleMap` (customer group → tier) is not a console concept. It shares one
  `ClaimMatcher` type and one "When someone signs in with… whose… includes…" rule editor with SSO
  rules (licensing domain, auto-mint).

---

## 6. Surface-area reduction

| Removed or merged                                                                                                                                                                             | Replaced by                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `isPlatformAdmin`, `canAdminProduct`, `hasAnyAdminGrant` (three names, one predicate) and about 12 handler-level re-checks                                                                    | One `can()` and one route-permission table, deny by default                                   |
| `SettingDef.capability` (declared on every entry, never read)                                                                                                                                 | The entry's area, read by `can()`                                                             |
| `products.admin_group`, `core.adminGroup`, manifest `product.adminGroup`, the Settings → General "Admin group" field, the docs paragraph explaining it does nothing, two EXPERIENCE copy rows | Nothing (retired). RB-05 offers a one-click SSO-rule conversion per product that declared one |
| Two operator identities (Pocket ID session and customer account) and two session models (stateless groups cookie, revocable account session)                                                  | One account. The console cookie is derived from and bound to the account session              |
| ST-21 + ST-22 + UX-42 + UX-02 + SETUP D12 / FLOWS F16 "Ask a platform admin" + UX-51 `requests_json` + W13 `setup.request`                                                                    | RB-01…RB-08, with one **Requests** concept (kinds `access` and `action`)                      |
| A collapsible "Platform" group plus always-on Home and Products links                                                                                                                         | Two flat, permission-filtered sidebar contexts                                                |
| Home and Products as two pages                                                                                                                                                                | One Home with a cards/table toggle (proposal, shared with the console-UX audit)               |
| Deployment and Operations                                                                                                                                                                     | Status (UX-30, unchanged)                                                                     |
| Override migration as a permanent nav item                                                                                                                                                    | An attention item and a Status link while active, then deleted                                |
| An 11,316 px single Platform settings page with hard-coded area filters                                                                                                                       | Registry-rendered sub-pages, frequency-ordered, with a rail or select                         |
| Two "group mapping" editors (customer `groupRoleMap` and console rules)                                                                                                                       | One `ClaimMatcher` and one rule editor component                                              |
| "No role names until ST-22" placeholders in EXPERIENCE O9 and SETUP §1.11                                                                                                                     | Real roles                                                                                    |

Net: one fewer table column and one manifest field, three fewer authz functions, one fewer
session realm, one fewer nav group and one fewer nav item. Three new tables (`console_members`,
`console_invites`, `console_requests`) and one rules table (`console_access_rules`). Bindings can
be a fifth table (`console_role_bindings`) or a JSON column on members; RB-01 decides, and the
recommendation is a table, for indexed scope queries.

---

## 7. Automation and onboarding

- **Zero-config upgrade.** The root rule turns every current `PLATFORM_ADMIN_GROUP` holder into a
  Superadmin at their next sign-in. No deploy variable is added or renamed.
- **Creator becomes admin.** Creating or linking a product grants the creator Product admin when
  they are not already a Superadmin. A product is never orphaned.
- **Invite email** with the role sentence. Without email delivery, the invite shows a copyable
  link, so nothing breaks.
- **Rule wizard with a live preview** ("Matches 3 people who signed in before: …") from stored
  link claims. It warns when a rule matches nobody and when it would grant Superadmin-equivalent
  access.
- **`adminGroup` conversion.** For each product whose manifest declared `adminGroup`, Access shows
  "DJDL's manifest names `djdl-admins`. Map it to DJDL admin?". One click, L2, step-up. The
  validator warns on the field from RB-05 on (shared-manifest, rule 9 drift gate, not wire).
- **Request routing.** Requests go to the narrowest scope's admins: Product admins for a product
  area, Platform admins for platform areas, Superadmins as the fallback. Each becomes an attention
  item and an email. Approval opens the grant drawer prefilled.
- **First-run Access empty state**: "You're the only Superadmin. Invite your team or map your IdP
  group", with the two actions and the role matrix.
- **Platform ready row** (UX-67): "Team access" is done when there is at least one member besides
  the root or one rule.
- **Docs**: a generated roles × areas matrix (a drift gate like `gen settings`) and a "Console
  access and roles" page with GitHub-style recipes (support team, release managers, a contractor
  on one product).
- **Graceful degradation.** Pocket ID down: a member with a passkey still signs in (better than
  today). Email down: copy links. Identity service off for a product: irrelevant, because accounts
  and the console are platform concerns. D1 unreachable: fail closed with "Can't reach Polaris
  Key".

---

## 8. Migration, data and risk

**Data (expand-only, migrations named `00XX_*`; numbers assigned by the lead):**

1. `00XX_console_access.sql`: `console_members`, `console_role_bindings`, `console_access_rules`,
   `console_invites`, `console_requests`, with indexes on `(account_id)`, `(scope_kind, product)`
   and `(status)`. `account_links.claims_json` (minimal: only claim names that some rule for that
   issuer references; `groups_json` stays) if RB-05 needs claims beyond groups and email domain.
2. No backfill is needed for roles: the root rule is computed. Members are created at first
   console sign-in after RB-03. The existing Pocket ID sessions (cookie without `mid`) are refused
   once, which means one redirect to sign in again, as the R1-08 cookie rename was.
3. **Audit continuity.** Old rows carry the Pocket ID `sub` in `actor_sub`. New rows carry the
   `mbr_` id. Activity resolves both: `sub` through `account_links` (issuer = console IdP) to the
   member. No rewrite of history.
4. **Contract phase (after RB-05 and ST-25).** Drop `products.admin_group`, the `core.adminGroup`
   entry and the manifest field (warned for one release first).

**Risks:**

| Risk                                                                                      | Mitigation                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lockout (bad rule, last admin removed)                                                    | The root rule is deploy-time and non-removable. Recovery is to set `PLATFORM_ADMIN_GROUP` and sign in. A RUNBOOK section covers it                                                                                                 |
| A stolen console cookie makes itself permanent by granting a role (AT-2)                  | Step-up within 5 minutes on every widening grant (a cookie alone cannot pass `prompt=login`), notification to the grantee and Superadmins, audit, no escalation, rules only on allowlisted issuers. AT-2 is amended with this tree |
| Customer-realm attacks now reach operators (email-code phishing, link and merge abuse)    | Strong-method rule for console entry. Step-up and email on link changes for members. Merge drops membership until re-approval. Disabled or deleted accounts end membership                                                         |
| G5 (customer placed in the operator group) returns                                        | Pocket ID stays operator-only (I-17). Rules are explicit per issuer. No grant comes from being a customer                                                                                                                          |
| Invite takeover via mailbox compromise                                                    | Single-use, 7-day expiry. Acceptance needs a strong method, not the email alone. The grantor is notified of acceptance                                                                                                             |
| Route-table gaps (a new route unguarded)                                                  | Deny-by-default in the dispatcher plus a coverage test over every admin route                                                                                                                                                      |
| Per-request cost                                                                          | One indexed read, cached 30 seconds per isolate. Admin traffic is small and already rate-limited                                                                                                                                   |
| Over-broad area mapping (an editor can widen security)                                    | Security-widening keys and the listed admin-only actions need Admin regardless of area                                                                                                                                             |
| In-flight specs written against "platform admin" (SETUP D12/D34, FLOWS F16, CM-03, UX-36) | Each maps cleanly: "platform admin" for team credentials becomes `platform.stores` edit; CM-03's "product-owner" becomes Product admin; UX-36 becomes `license` edit                                                               |
| Decision-record conflict (S-16 decision 3, S-18 D10, S-13 §8.2)                           | RB-01 records the owner's 2026-10-07 direction, amending, not silently overriding                                                                                                                                                  |

**Plan mode.** RB-01 is plan mode: an authorization-model change is a THREAT-MODEL §9 trigger, and
ST-22 was already plan mode. **No wire plan-mode event.** Gates: THREAT-MODEL, rule 10 (narrative
admin routes and route coverage), rule 3 (`TABLE_OWNERS` for the new tables), rule 9 (the
`adminGroup` deprecation in shared-manifest), the docs drift gate for the generated roles matrix,
and a security review before RB-04 merges.

---

## 9. Backlog changes

| id               | action | target                                                                                               | note                                                                                                                                                                                                                                                                          |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ST-21            | merge  | RB-02                                                                                                | Widened from "settings writes" to every admin route (route-permission table, deny by default), `/me.permissions`, `useCan`, permission-aware nav and NoAccessPage. Drops the ST-05 dependency (settings-key checks plug in when ST-05 lands). Behaviour unchanged until RB-04 |
| ST-22            | split  | RB-01, RB-03, RB-04, RB-05                                                                           | No longer optional (owner brief). The plan becomes RB-01; implementation is split by layer                                                                                                                                                                                    |
| ST-05            | edit   | ST-05                                                                                                | Its "authz tests per scope" call `can()` once RB-02 exists, else `isPlatformAdmin` as today                                                                                                                                                                                   |
| ST-07            | edit   | ST-07                                                                                                | `SettingsRow` renders read-only through `useCan` with **Request access**                                                                                                                                                                                                      |
| ST-08            | edit   | ST-08                                                                                                | Hub gains an **Access** area (RB-04 provides it) and drops the Admin group row. "Common" settings first in General                                                                                                                                                            |
| ST-09            | edit   | ST-09                                                                                                | Frequency-ordered sub-pages (§5.6), "Recently changed" strip, registry-rendered (no area silently dropped), Access and identity moved to Access → SSO rules, phone select                                                                                                     |
| ST-10            | edit   | ST-10                                                                                                | ⌘K results filtered by `view` permission                                                                                                                                                                                                                                      |
| ST-12            | keep   | —                                                                                                    | Its editors (device trust, auto-issue) are `securityWidening`, so Admin only through RB-02's rule                                                                                                                                                                             |
| ST-16            | keep   | —                                                                                                    | Supplies Product defaults' fan-out counts                                                                                                                                                                                                                                     |
| ST-27            | edit   | ST-27                                                                                                | Adds an `access.changed` alert kind (grants, rules, root sign-ins)                                                                                                                                                                                                            |
| ST-25            | edit   | ST-25                                                                                                | Also retires `products.admin_group`, `core.adminGroup` and manifest `product.adminGroup` (after RB-05's conversion offer)                                                                                                                                                     |
| CM-03            | edit   | CM-03                                                                                                | "Product-owner capability only (ST-21)" becomes "Product admin plus step-up (RB-02/RB-04)"                                                                                                                                                                                    |
| I-03             | keep   | —                                                                                                    | Done. `ADMIN_OIDC_*` becomes the console IdP the root rule reads                                                                                                                                                                                                              |
| I-12             | keep   | —                                                                                                    | Done. Its step-up is reused. The console's "Users" stay end users; operators live under Access → Members                                                                                                                                                                      |
| I-17             | keep   | —                                                                                                    | Done. Pocket ID stays operator-only, which keeps the G5 mitigation                                                                                                                                                                                                            |
| UX-42            | merge  | RB-07                                                                                                | The console login card becomes account-based (passkey or SSO, strong-method rule)                                                                                                                                                                                             |
| UX-02            | merge  | RB-07                                                                                                | In-place signed-out and session-ended states belong to the same card                                                                                                                                                                                                          |
| UX-51            | edit   | UX-51                                                                                                | `setup_state.requests_json` and W13 `setup.request` move to RB-06's `console_requests` (kind `action`). UX-51 keeps choices, skips, assertions and the Set up consent                                                                                                         |
| UX-12            | keep   | —                                                                                                    | Hosts the `access.request` and `setup.request` attention kinds                                                                                                                                                                                                                |
| UX-13            | edit   | UX-13                                                                                                | Account menu: "My library" link and role chip. The sidebar context header comes from AD-01                                                                                                                                                                                    |
| UX-30            | keep   | —                                                                                                    | Status = Deployment + Operations; Override migration links from here                                                                                                                                                                                                          |
| UX-36            | edit   | UX-36                                                                                                | Gated by `license` edit via RB-02 (was "ST-21")                                                                                                                                                                                                                               |
| UX-67            | edit   | UX-67                                                                                                | Adds the "Team access" row                                                                                                                                                                                                                                                    |
| PX-19            | edit   | PX-19                                                                                                | Portal docs mention "Open console" for members                                                                                                                                                                                                                                |
| Design specs     | edit   | ADMIN.md §2.1, §5.10, §6.9; EXPERIENCE O9; SETUP D12, D34, §1.11; FLOWS F16, C16; SIGN-IN §3.12 copy | "Ask a platform admin" becomes "Request access" routed to the scope's admins. §5.10 describes the real `useCan`. §6.9 drops Admin group                                                                                                                                       |
| Decision records | edit   | S-16 §5.6 and decision 3; S-18 §4.8 and D10; S-13 §8.1–8.2; THREAT-MODEL AT-2 and :5139              | RB-01 writes the amendments                                                                                                                                                                                                                                                   |

---

## 10. New work packages

| id        | Title                                                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                         | Deps                              | Plan mode     | Size (wk) |
| --------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------- | --------- |
| **RB-01** | Plan: console RBAC and account-backed console identity   | Decision record amending S-16 D3, S-18 D10 and S-13 §8.2. Roles × areas table, scopes, grant rules, root rule, strong-method rule, data model (DDL), route-permission table design, session binding, request routing, the AT-2 amendment and new attack-tree rows, privacy notes (member ids, claim retention). Security review checklist                                                                     | none                              | **yes**       | 0.6–0.8   |
| **RB-02** | Permission engine on every admin route (was ST-21)       | `can()` in `admin/authz.ts`; `ADMIN_ROUTE_PERMISSIONS` enforced in `admin/api.ts` with a coverage test over every admin route; delete the handler-level `isPlatformAdmin` re-checks; `writeSetting()` area check; `/me.permissions`; `useCan`; nav, palette and attention filtering; `NoAccessPage`; every write control's `disabledReason` + Request access slot. With only the root, behaviour is unchanged | RB-01                             | no            | 1.0–1.4   |
| **RB-03** | Account-backed console sessions                          | `/manage/callback` → I-05 `signIn` (same Pocket ID link as portal SSO); `console_members` (`mbr_` ids); cookie carries `mid` + `sid`, no `groups`; per-request member and session check with 30-second cache; computed root rule; docs gate on membership; audit actor = member with `sub` resolution for history; account merge, deletion and disable hooks end membership                                   | RB-01, RB-02                      | follows RB-01 | 0.8–1.1   |
| **RB-04** | Roles, bindings, invites and the Access pages            | `console_role_bindings`, `console_invites`; the six built-in roles; scopes including All products; area narrowing; grant rules (no escalation, step-up, L1/L2, notify, audit); creator becomes Product admin; Platform → Access (Members, Invite, Roles matrix generated with a drift gate); Product → Settings → Access (standalone page until ST-08's hub)                                                  | RB-03; ST-08 (optional, degrades) | follows RB-01 | 1.4–2.0   |
| **RB-05** | SSO rules (IdP group and claim mappings)                 | `console_access_rules`; issuer allowlist check; matchers (`groups` includes, verified email domain, one named claim equals); minimal `claims_json` retention; evaluation at sign-in; the root rule card; the rule flow with match preview; `adminGroup` conversion offers and the shared-manifest deprecation warning; a shared `ClaimMatcher` with licensing's auto-mint rules                               | RB-04                             | follows RB-01 | 0.8–1.1   |
| **RB-06** | Requests: request access and request an action           | `console_requests` (kinds `access`, `action`); Request access from NoAccessPage and disabled controls; routing to scope admins; attention kinds and email; approve opens the grant drawer; absorbs UX-51's `requests_json` and W13                                                                                                                                                                            | RB-04; UX-12 (optional)           | no            | 0.6–0.9   |
| **RB-07** | Console sign-in on the login card (absorbs UX-42, UX-02) | Identifier-first console card; Continue with the console IdP or a passkey; strong-method rule with step-up for email-only sessions; "doesn't have console access" state with Open your library; in-place signed-out and session-ended states; "My library" and "Open console" cross-links                                                                                                                     | RB-03; UX-40; I-16 (done)         | no            | 1.0–1.4   |
| **RB-08** | RBAC docs, threat model and close-out                    | Docs "Console access and roles" plus the generated matrix; THREAT-MODEL AT-2 amendment and rows (grant escalation, rule hijack, invite takeover, strong-method bypass); RUNBOOK lockout recovery; ADMIN, EXPERIENCE, SETUP, FLOWS and SIGN-IN amendments; `adminGroup` contract-phase drop with ST-25                                                                                                         | RB-04, RB-05, RB-06, RB-07        | no            | 0.4–0.6   |
| **AD-01** | Console contexts: Platform and Product sidebars          | Flat Platform context (Home with cards/table toggle, Access, Settings, Store connections, Package feeds, Status, Activity); product context header with the switcher and Platform back link; Home and Products out of the product sidebar; Override migration out of the nav (attention plus Status link); permission filtering via `useCan`                                                                  | RB-02; UX-30                      | no            | 0.6–0.9   |

Total: about 7.2–10.2 engineer-weeks, against 1.7–2.4 for ST-21 + ST-22 plus UX-42 and UX-02
(about 1.5–2), whose scope this absorbs. **Critical path:** RB-01 → RB-02 → RB-03 → RB-04 (about 4
weeks to "per-product access works"). RB-05, RB-06, RB-07 and AD-01 can run in parallel after
their dependencies.

---

## 11. Quick wins (no RBAC needed)

1. **Hide the Admin group field.** Remove the input from Core → Settings → General
   (`pages/core/Settings.tsx:312-336`) and from ProductNew. Correct the `core.adminGroup` readers
   (`core/settings/core.ts:83` lists `admin/api.ts`, which only mentions it in a comment).
2. **Fix the threat-model drift.** THREAT-MODEL:5139 says "(or a product admin group)", which is
   false.
3. **Fix the ADMIN.md §5.10 drift.** Either say that `useCan` is not built yet, or land a 20-line
   `useCan()` that returns `me.platformAdmin`, so UI work can thread it now. The second is better
   and makes RB-02's UI half mechanical.
4. **A better callback 403.** Replace "Your account is not an administrator of any product." with
   SIGN-IN.md's copy (`signin.console.notOperator`): "{email} isn't in the operators group", plus
   **Use another account** and **Open your library** (`admin/auth.ts:333-338`).
5. **Render every registered platform key.** Show `storefront.polarisKey.enabled` and the
   `product-defaults` area's live (non-pending) keys on Platform → Settings, or render all areas
   from the registry, so nothing is silently dropped (`platformSettings.tsx:332,338,387,1049`).
6. **Move Override migration out of the Platform sidebar** (`nav.ts:813-826`) into an attention
   item, keeping the route.
7. **Add a "My library" link** to the console account menu (`console/shell/UserMenu.tsx`).
8. **Delete the redundant re-checks.** `trustPolicy.ts:62`, `outletCredentials.ts:80` and
   `ciPublishing.ts:122,153` re-check `isPlatformAdmin` after the dispatcher's `canAdminProduct`.
   Fold them into one comment, or leave them for RB-02's table, but do not add more.

---

## 12. Cross-domain dependencies

- **Identity and accounts.** RB-03 and RB-07 need I-05 `signIn`, `account_sessions` revocation,
  AMR on sessions, passkeys (I-16), the login card (UX-40) and the email-gate join flow (PX-21)
  for operators whose Pocket ID link and existing account differ. The identity domain's "SSO
  connections with email-domain routing" must keep issuers behind `OIDC_ISSUER_ALLOWLIST`, which
  RB-05's rules rely on. Account merge and deletion hooks must call RB's membership hooks.
- **Licensing (auto-mint by OIDC group).** Share one `ClaimMatcher` type and one rule-editor
  component with console SSO rules. The customer `groupRoleMap` should be renamed by that domain
  (it maps to tiers, not roles), to stop the "role" word colliding with console roles.
- **Feeds and access tokens.** "Developers and administrators see SDK packages" reads RB's
  `isConsoleMember(accountId)` Core hook to unlock the system product's feeds on a member's
  tokens.
- **Settings program (ST-\*).** RB-02 provides `can()` for ST-05, ST-07 and ST-08. ST-08 hosts the
  Access area. ST-09 implements §5.6. ST-25 drops `adminGroup`. ST-27 carries `access.changed`
  alerts.
- **Release, distribution and commerce consolidation.** Areas are sidebar sections, so a new
  Commerce or "distribution channel" section becomes an RBAC area automatically. Team store
  credentials stay `platform.stores` (S-15 §8.1). CM-03's merchant setting needs Product admin
  plus step-up.
- **Onboarding (product wizard, Integration section).** The creator becomes Product admin. The
  Integration section and launch path filter steps by `useCan`, and a disallowed step shows
  Request access (RB-06), never a dead end.
- **Console UX (product card, Home).** AD-01's Home with the cards/table toggle is where the
  simplified product card lives, filtered by permission.
- **Portal.** "Open console" for members needs a Core hook readable from the portal realm without
  importing the admin layer (rule 6).
- **Security.** THREAT-MODEL AT-2 amendment, a §9 trigger, and a security review before RB-04
  merges (ST-22's human input carried over).
