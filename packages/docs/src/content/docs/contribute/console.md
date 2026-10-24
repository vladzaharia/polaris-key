---
title: "Add a page, a setting, a wizard, or a write"
description: "Extend the operator console through its page registry, settings engine, routed flows, write invalidation table, permissions, and tests."
type: "reference"
lastReviewed: "2026-10-11"
sidebar:
  order: 10
---

This guide traces the console extension points in `packages/admin/src`. Keep a screen's route,
access rule, server endpoint, query cache, and tests aligned.

## Add a page

A product page starts in `packages/admin/src/console/nav.ts`. Add its id to `ProductPageId` and
its `NavPage` declaration to the appropriate section. The declaration owns the path, sidebar
label, icon, documentation path, record shape, and feature requirements. The router derives its
matching and typed URL builders from this table.

Add the page component to that section's `index.tsx` switch. Section modules are lazy-loaded by
`packages/admin/src/console/pages/index.tsx`, so keep the page in its owning section. A global
page also needs its `GlobalPageId` and `GLOBAL_PAGES` entry, then a branch in
`packages/admin/src/console/shell/AppShell.tsx`.

Give every page an area in `packages/admin/src/console/access/can.ts`. The shell uses
`canOpenPage()` before it renders a page. Hide unavailable navigation and actions with the same
permission model, but do not treat that client check as authorization. Add the matching Worker
route permission check as well; the Worker decides every `/manage/api` request.

Update the route and access coverage in `packages/admin/test/route.test.ts` and
`packages/admin/test/access.test.tsx`. If the page declares a documentation path, it must be an
absolute `/docs/` path ending in `/`; `packages/admin/test/docsLinks.test.ts` checks the console
shape and the Worker checks the built site target.

## Add a setting

Use the shared settings engine in `packages/admin/src/ui/settings/`. `SettingRow` supplies the
control, draft state, confirmation, conflict reload, error, keyboard behavior, and accessible
state. Its `SettingSpec` and `SettingConfirm` types in `model.ts` define the control and the
confirmation level.

Product settings come from the Worker's effective-settings response. Use
`packages/admin/src/console/components/ProductSettingsSection.tsx` for a group of those rows. It
reads `ProductSetting` values, ownership, version, schema, and confirmation rules; it saves and
reverts through the shared write path. Supply the area, row keys, precise consequences, and any
value labels from the page that owns the settings. Do not duplicate the row UI or infer ownership
in the browser.

Platform settings use the same engine through
`packages/admin/src/console/sections/platform/pages/platformSettingRow.tsx`. The Worker registry
provides each platform setting's kind, bounds, choices, value, version, and confirmation rules.
`specOf()` and `confirmOf()` adapt that response to `SettingRow`.

A settings write carries the version it read. Preserve the 409 conflict path, confirmation
consequences, source information, and revert behavior. Add server validation and the setting's
registry entry with the response shape before adding a console row.

## Add a wizard

A wizard is a routable page, not a modal that owns hidden state. The shipped example is
`packages/admin/src/console/sections/global/pages/ProductNew.tsx`, registered as
`product-new`. It holds its draft in the page, validates before submission, preserves a draft
across navigation, guards against discarding unsaved input, and leaves a server refusal beside
the relevant field.

Build a flow with the same boundaries:

1. Register the route and page, then use `PageHeader` and `Breadcrumbs` for its location.
2. Keep the draft, field errors, pending state, and discard guard in the flow.
3. Validate inputs locally for immediate feedback, but keep the Worker as the authority.
4. Use the normal mutation path for submission. Navigate only after the server confirms the
   result.
5. Test the starting state, invalid fields, refusal, pending state, successful return path, and
   keyboard and accessible dialog behavior.

## Add a read

A read is a `queryOptions` factory next to its query key, never a `useQuery({ queryFn })` in a
page. Add the typed client method in the app's API modules (`packages/admin/src/console/api/<area>.ts`
for the console, `packages/admin/src/portal/api/<area>.ts` for the portal; `src/api.ts` and
`src/portal/api.ts` only re-export them). Both go through the one HTTP client in
`packages/admin/src/lib/http.ts`, which is the only module that calls `fetch` and the only place an
`HttpError` is made.

Then add the key and the factory:

- Console: the key goes in `packages/admin/src/console/data/queries.ts` (`qk`). A read used by more
  than one section, or by the shell, is a factory in `console/data/reads.ts`; a section's own read
  is a factory in that section's `data.ts`. A page calls `useQuery(reads.x(...))`, or spreads the
  factory to add `enabled`, `select` or `placeholderData`.
- Portal: one `qk` entry and one `pq` factory in `packages/admin/src/portal/queries.ts`, which is
  the only portal file that spells a `queryKey` or `queryFn`. A hook calls `useQuery(pq.x(...))`.

Each key family has exactly one factory. `packages/admin/test/queryFactories.test.ts` scans the
source and fails on a `queryFn`, a `queryKey` literal or a bare `api.*` read outside a data module
(console) or outside `portal/queries.ts` (portal), and on a key family with two factories.

## Add a write

Add the typed client method in the app's API modules (see above). Both apps share one write engine,
`packages/admin/src/lib/writes.ts`; each keeps its own table.

- Console: add the method to `WriteMethod` and exactly one entry in `MUTATIONS` in
  `packages/admin/src/console/data/mutations.ts`, and call it with `mutate("method", ...)`.
- Portal: add exactly one entry to `PORTAL_MUTATIONS` in
  `packages/admin/src/portal/mutations.ts`. A hook calls it with `useWrite("method")`, which is
  `mutate` as a TanStack mutation (`toArgs`, `call`, `onSuccess` and `onError` cover what the table
  cannot say).

Declare all query keys made stale by a confirmed write, using the keys in the app's `qk`
(`console/data/queries.ts`, `portal/queries.ts`). The engine calls the API first and invalidates
only after a successful response; it does not invalidate after a refusal. Choose the narrowest
correct key prefixes. If a write invalidates nothing, record why in the entry's `why`. A write whose
variables or answer carry a secret sets `gcTime: 0`.

The write must also have its Worker handler, authorization, request validation, audit behavior,
and route contract. Add the Worker route to
`packages/worker/openapi/polaris-key.v3.yaml` and its route-coverage table when it is a new API
route.

`packages/admin/test/mutations.test.ts` (console) and `packages/admin/test/portalMutations.test.ts`
(portal) call every API method and require the table to match all non-GET methods. View code that
writes around the table, or that calls `fetch` directly, fails
`packages/admin/test/noDirectFetch.test.ts` and the boundary tests. Add focused page tests for the
success, refusal, and stale-data result that matter to the screen.

## Never read around an older Worker

The console and the portal ship inside their Worker (`worker assemble`), so a page only ever meets
the Worker it was built with. Type a field the Worker always sends as required, and read it as
given: no `?? fallback`, no "an older Worker omits it" branch, no comment saying so. A fixture
carries the field, as the Worker would.

Tolerate data a newer Worker may send. `libraryFromWire` skips a library entry kind this build does
not know, because that guards against newer data, not an older Worker.

## Check the change

Run the focused console tests while you work, then run the package checks and docs link check:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- route.test.ts access.test.tsx mutations.test.ts queryFactories.test.ts
mise exec node@22 -- pnpm --filter @polaris-key/admin typecheck
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

Run the repository green gate before opening a PR. See [Set up the repo](/docs/contribute/setup/) for the
full command set.
