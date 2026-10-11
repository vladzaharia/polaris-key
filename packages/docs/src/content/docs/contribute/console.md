---
title: "Add a page, a setting, a wizard, or a write"
description: "Extend the operator console through its page registry, settings engine, routed flows, write invalidation table, permissions, and tests."
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

## Add a write

Add the typed client method in `packages/admin/src/api.ts`. For every non-GET method, add the
method to `WriteMethod` and exactly one entry in `MUTATIONS` in
`packages/admin/src/console/data/mutations.ts`. Declare all query keys made stale by a confirmed
write, using the keys in `packages/admin/src/console/data/queries.ts`.

Call the write with `mutate("method", ...)`, not `api.method(...)`. `mutate()` calls the API
first and invalidates only after a successful response. It does not invalidate after a refusal.
Choose the narrowest correct key prefixes. If a write invalidates nothing, record why in its table
entry.

The write must also have its Worker handler, authorization, request validation, audit behavior,
and route contract. Add the Worker route to
`packages/worker/openapi/polaris-key.v3.yaml` and its route-coverage table when it is a new API
route.

`packages/admin/test/mutations.test.ts` calls every API method, requires the invalidation table
to match all non-GET methods, and rejects direct API writes from view code. Add focused page tests
for the success, refusal, and stale-data result that matter to the screen.

## Check the change

Run the focused console tests while you work, then run the package checks and docs link check:

```sh
mise exec node@22 -- pnpm --filter @polaris-key/admin test -- route.test.ts access.test.tsx mutations.test.ts
mise exec node@22 -- pnpm --filter @polaris-key/admin typecheck
mise exec node@22 -- pnpm --filter @polaris-key/admin build
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

Run the repository green gate before opening a PR. See [Setup](/docs/contribute/setup/) for the
full command set.
