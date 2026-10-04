# F-11 Console: the Feeds overview and per-feed pages in both scopes, the package record and the admin API

| Field       | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                             |
| Size        | 2–3 engineer-weeks                                                                  |
| Depends on  | [F-03](F-03-package-releases.md)                                                    |
| Unblocks    | [F-12](F-12-console-feed-settings.md), [F-21](F-21-registry-auth.md)                |
| Role        | `pkey-implementer`                                                                  |
| Plan mode   | no: follows [`plans/F-01.md`](../plans/F-01.md) §6.9                                |
| Gates       | docs links and help-link tables; console CSP parity; THREAT-MODEL (admin mutations) |
| Human input | none                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                           |

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

- [ ] Both scopes render from the same components. The product scope hides Owner and appears only
      with `packageFeeds` on.
- [ ] Every mutation writes its audit action from plan §6.9. Yank is refused with
      `unsupported_by_ecosystem` where the protocol has no such state.
- [ ] `adminCspParity` and `check:links` pass. The green gate passes (`AGENTS.md`).

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
