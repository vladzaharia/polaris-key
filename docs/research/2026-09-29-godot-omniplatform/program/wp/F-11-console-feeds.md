# F-11 Console: the Feeds overview and per-feed pages in both scopes, the package record and the admin API

| Field       | Value                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                     |
| Size        | 2–3 engineer-weeks                                                                                          |
| Depends on  | [F-03](F-03-package-releases.md)                                                                            |
| Unblocks    | [F-12](F-12-console-feed-settings.md), [F-21](F-21-registry-auth.md), [A-18j](A-18j-console-storefronts.md) |
| Role        | `pkey-implementer`                                                                                          |
| Plan mode   | no: follows [`plans/F-01.md`](../plans/F-01.md) §6.9                                                        |
| Gates       | docs links and help-link tables; console CSP parity; THREAT-MODEL (admin mutations)                         |
| Human input | none                                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                                   |

## Goal

Platform admins manage package feeds from the console in two scopes, built from one component set:

- **Platform:** `#/platform/feeds…`, in S-13's Platform section.
- **Product:** `#/p/:slug/distribution/feeds…`, shown when `packageFeeds` is on.

The scopes provide the Feeds overview; the per-feed page with Packages, Setup, Settings (common
sections) and Activity tabs; and the package record with yank, unyank and deprecate. The admin API
of plan §6.9 serves both scopes, audited.

## Why

The owner asked for one Feeds overview and one page per feed, with per-feed settings, in both
scopes ([S-12 §10.1](../../notes/S-12-package-feeds.md#101-console-design-f-11-f-12-against-docsdesignadminmd)).

## Read first

- [`plans/F-01.md`](../plans/F-01.md) §6.3 (`packageFeeds`), §6.9.
- `docs/design/ADMIN.md` §2–§7; [notes/S-13](../../notes/S-13-platform-settings.md) §7;
  `packages/admin/src/console/nav.ts`; `packages/worker/src/admin/authz.ts`;
  `services/distribution/admin.ts`.

## Scope

**In:**

- `<FeedsOverview scope>`, `<FeedPage scope ecosystem>`, the package record and the `FeedScope`
  type.
- The admin handlers for both scopes and the `platformAdmin` seam in `mount.ts`.
- The `packageFeeds` toggle in Core → Services.
- Audit rows; `admin/feeds.md`; the help links in both tables.

**Out:**

- Per-ecosystem panels and snippets (→ [F-12](F-12-console-feed-settings.md)).
- Token UI (→ F-21).

## Design notes

- **Dependencies outside the graph:** ADMIN chunk 3 (`DataTable`, `StatTile`, `PageTabs`,
  `SaveBar`, `CopyField`, `StatusPill`, `Timeline`) and S-13's Platform section. If the Platform
  section has not landed, mount at a temporary platform link and leave a note for S-13's
  packages.
- Each settings section saves through its own `SaveBar`, with `expectedVersion` and 409 on a
  mismatch. Access modes other than Public render disabled with "Available when registry auth
  ships".
- No delete control anywhere.

## Steps

1. Admin handlers with tests, then the seam.
2. Overview, feed page and package record.
3. The Services toggle, docs and help links.

## Acceptance criteria

- [x] Both scopes render from the same components. The product scope hides Owner and appears only
      with `packageFeeds` on.
- [x] Every mutation writes its audit action from plan §6.9. Yank is refused with
      `unsupported_by_ecosystem` where the protocol has no such state.
- [x] `adminCspParity` and `check:links` pass. The green gate passes (`AGENTS.md`).

## Corrections (recorded while implementing, against the code)

Where the code disagreed with the brief or plans/F-01.md §6.9, the code was the fact. No wire shape,
corpus or `PROTOCOL_VERSION` changes.

1. **No `platformAdmin` descriptor seam.** The plan sketched product routes as a Distribution
   `adminHandle` plus a `platformAdmin?: AdminRoute[]` member registered in `mount.ts`. A yank,
   unyank and deprecation write Release's `release_packages` (with `release_yanks` and the pack-set
   invalidation) while the settings are Distribution's tables, and a service may not call another
   (rule 6). The one place both compose is the admin layer, which already composes them for the
   system-product bootstrap (`admin/systemProduct.ts`) and imports services elsewhere. So one handler
   set, `packages/worker/src/admin/handlers/feeds.ts`, serves both scopes: `handlePlatform` routes
   `/platform/feeds/*` (bootstrap stays where F-03 put it), and `admin/api.ts` routes
   `/products/:slug/distribution/feeds/*` before the Distribution descriptor. Core still imports no
   service.
2. **Audit actions through Release.** Release's `yank`, `unyank` and `setPackageDeprecation` take an
   optional `auditAs` so the console's verbs audit `package.version.{yank,unyank,deprecate,undeprecate}`
   against `{kind: "package", id: "<eco>:<name>@<version>"}` through the same write. `undeprecate`
   is added beside the plan's three (lifting a deprecation is the npm protocol's inverse).
3. **Capabilities per protocol** (notes/S-12 §8.2): npm deprecate only (yank refused); PyPI, Swift,
   Maven, OCI and Godot yank only (deprecate refused). `yankHidesFromIndex` applies to Maven only.
4. **Platform scope is the system product's feeds** (owner requirement): settings write the system
   product's feed; the packages list opens on `owner=polaris-key` with an "All owners" toggle (the
   API lists every owner by default, per the plan); an Owners panel lists every product with a
   `packageFeeds` row. Before the bootstrap the overview offers **Set up platform feeds** (L1).
5. **Access copy.** Modes other than Public render as "Unavailable" with the reason (the registry
   issues no credentials), not "Available when registry auth ships" (owner: no implementation-status
   copy). The server refuses them with `access_mode_unavailable`.
6. **No Claims section.** The plan's "Public-name claims" section is omitted: we never publish to
   public registries and nothing in the UI suggests it. `claims_json` is untouched (and refused as a
   settings field).
7. **Setup snippets** are a basic per-ecosystem renderer in the SPA (`areas/feeds/model.ts`
   `setupSnippets`), because the owner asked for a setup snippet per feed now; F-12 replaces it with
   `renderFeedSetup` in `@polaris-key/manifest` and registers ecosystem panels in
   `FEED_PANELS` (`areas/feeds/FeedSettings.tsx`), which renders after the common sections.
8. **Routing.** Global routes gain records (`#/platform/feeds/:eco[/:tab]`) and both scopes gain a
   nested record (`NavRecord.child`: `…/:eco/packages/:name` in product scope, `:owner/:name` in
   platform scope). The product nav item carries `requires: "packageFeeds"`, read from a new
   `packageFeeds` field on the product row. Platform → Package feeds flips to `ready: true`; each
   feed is its own page, linked from a per-feed nav row above the overview and every feed page.
9. **Docs page and help links.** `admin/feeds.md` (the nav's docs for both pages, `docsLinks`
   `packageFeeds`/`packageFeedsHost`); `services-enablement.md`, `console-tour.md` and
   `services/distribution/package-feeds.md` link it.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- admin feeds
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/admin build && mise exec node@22 -- pnpm --filter @polaris-key/worker test adminCspParity
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- F-12 plugs ecosystem panels into the Settings tab and the Setup tab.
- F-21 enables the disabled access modes and adds token pages.

The role agent sets `--set F-11 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-11 done`.
