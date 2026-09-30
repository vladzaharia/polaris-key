# P0-11 Fix documentation drift and macOS-only assumptions in health and setup

| Field       | Value                                                                                 |
| ----------- | ------------------------------------------------------------------------------------- |
| Phase       | P0: Hygiene and unblockers                                                            |
| Size        | 0.25–0.5 engineer-weeks                                                               |
| Depends on  | none                                                                                  |
| Unblocks    | none                                                                                  |
| Role        | `pkey-implementer`                                                                    |
| Plan mode   | no                                                                                    |
| Gates       | docs `check:links`; console help-link test; worker and admin tests for the code parts |
| Human input | none                                                                                  |
| Repo        | `vladzaharia/polaris-key`                                                             |

## Goal

The docs, the OpenAPI text and the runbook say what the code does today, and a product that does
not ship macOS DMGs or does not run License is no longer told forever that it "needs setup". The
customer portal stops listing signature and checksum sidecars as downloads.

## Why

Report [§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) issues #20 (docs
drift), #21 (health and setup checklists assume macOS, Sparkle and License) and #22 (portal
downloads), and the "one entry in `mount.ts`" claim in
[§3.2](../../README.md#32-service-model-release-distribution-and-update-across-everything-delivered).
Evidence in [notes/A1 §9](../../notes/A1-release-update.md#9-docspec-drift-noticed-along-the-way)
and [notes/A3 §6](../../notes/A3-admin-dx.md#6-docs-and-skills-to-add-or-change). Wrong docs are
worse than missing docs here: adopters (and agents, AGENTS.md rule 11) build on them.

## Read first

- `AGENTS.md` ("Conventions when writing docs pages", rule 4) and `start/concepts.md`.
- Each file named in the table below, and the code it describes.
- `packages/worker/src/services/release/health.ts:61-95,230-300`,
  `packages/worker/src/admin/lib/shape.ts:295-330`,
  `packages/admin/src/views/ProductOverview.tsx:280-360`,
  `packages/worker/src/services/identity/portal/repo.ts:700-713`.

## Scope

**In** (each row is a claim, the code that contradicts it, and the fix; short docs paths are
under `packages/docs/src/content/docs/`, short code paths under `packages/worker/src/` and its
`services/release/` or `services/update/` directories):

| Claim                                                                                            | Where                                                                                                             | What the code does                                                                                                                                                                                                                       | Fix                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `authenticated` "doesn't need a usable licence"                                                  | `packages/docs/src/content/docs/services/release/artifacts.md:90-91`                                              | `enforceReleaseAccess` requires a usable licence for both `authenticated` and `licensed` (`services/release/access.ts:109-152`)                                                                                                          | say both require one and behave identically today                                                   |
| a pinned selector may be `v1.2.3`                                                                | `packages/worker/openapi/polaris-key.v3.yaml:1422-1423`                                                           | `classifyChannel` needs `^\d+\.\d+\.\d+` (`channels.ts:61`)                                                                                                                                                                              | pinned `1.2.3` only (it matches a `v1.2.3` or `1.2.3` tag once P0-02 lands)                         |
| `?channel=` accepts a pinned `X.Y.Z`                                                             | `polaris-key.v3.yaml:1613`, `services/update/eligibility.md:28-32`                                                | the `[a-z0-9-]` alphabet excludes dots (`update/routes.ts:20,39-42`)                                                                                                                                                                     | drop the pinned case from both                                                                      |
| "Release itself is not macOS-specific"                                                           | `services/release/index.md:89-92`                                                                                 | the download route serves only extension-less binaries and `.dmg` files (`routes.ts:42`, `assets.ts:173`)                                                                                                                                | describe what is served today; classification is truth-store only                                   |
| config secrets go to the OS keyring                                                              | `services/config/index.md:121`, `services/config/catalog.md:200`, `start/concepts.md:208`, `agents/recipes.md:57` | the device token is in the keyring (Node, Python, Swift); config secrets ride the cached document in a 0600 `managed.json` (`sdk-node/src/core/store.ts:102`; [notes/E9 §6](../../notes/E9-runtime-building-blocks.md#6-secure-storage)) | say which is where; keep the guidance for host apps separate                                        |
| adding a service is "one entry in `mount.ts`, one slug in `SERVICE_NAMESPACES`, and a directory" | `start/architecture.md:37-38`, `contribute/layout.md:86-87`, comment `packages/worker/src/mount.ts:11-12`         | Core enumerates slugs too (`core/services.ts:20-66`, `core/discovery.ts:74-80`), as do the manifest package, console and SDKs                                                                                                            | state that it is a multi-file change and name the main places; P0-09 replaces this with a checklist |
| runbook checks `/djdl/schema`                                                                    | `docs/RUNBOOK.md:277`                                                                                             | the route is `/djdl/config/schema`                                                                                                                                                                                                       | fix the URL                                                                                         |

**Code, for issues #21 and #22:**

- `checkReleaseHealth`: the arm64 DMG check reports `missing` whenever the asset is absent
  (`health.ts:241-258`), unlike the x86_64 check, which honours `requireDmg` (`health.ts:260-274`).
  Make both honour `requireDmg` and skip the DMG and Sparkle-signature checks entirely when the
  product requires no DMG and its latest release has none; the Sparkle check
  (`health.ts:275-300`) then applies only to products that ship DMGs.
- Setup state: the "Sparkle public key not configured" warning (`admin/lib/shape.ts:311-314`) only
  when Update is enabled and the product ships DMGs (same predicate).
- Console setup checklist: the "License defaults" and "Issue a license" items
  (`ProductOverview.tsx:315-331`) only when License is enabled.
- Portal: `listPortalArtifacts` (`identity/portal/repo.ts:700-713`) excludes `kind IN ('signature', 'checksum')`.
  Document the remaining limits (downloads need sign-in and a licence; redirects go only to GitHub
  hosts) on `users/portal.md` and `services/identity/portal.md` as current behaviour.

**Out** (and where it belongs instead):

- The `artifact_policy_json` "operator-owned" comments and the `architectures` schema/validator
  length mismatch, both in issue #20 (→ [P0-01](P0-01-operator-ownership.md), which makes the
  comments true and fixes the schema under rule 9).
- "The webhook keeps a linked product current" in `services/release/github-sync.md`
  (→ [P0-03](P0-03-release-webhook.md), which makes it true and edits that page).
- Public downloads without sign-in, and non-GitHub byte hosts (→ P2b-06, P2-05).
- The "Adding a service" checklist (→ [P0-09](P0-09-service-table.md)).

## Design notes

- Docs conventions: quoted frontmatter values, no bare `{`/`}` in MDX prose, absolute internal
  links ending in `/`. Renaming a page means updating `packages/admin/src/route.ts` and
  `packages/admin/src/lib/docsLinks.ts` in the same change; this package should not rename any.
- The OpenAPI edits touch descriptions only; `routeCoverage` is unaffected and the generated
  `reference/routes.mdx` (method, path, tag, summary only) does not change. Run `gen:check` anyway.
- "Ships DMGs" predicate, one helper used by health and setup state:
  `requireDmg !== false || latestRelease has a .dmg asset`. With no `artifact_policy_json` the
  default is `requireDmg: true` (`health.ts:65-76`), so djdl's behaviour is unchanged.
- Coordinate with P0-02 on the pinned-selector wording if it lands first.

## Steps

1. Fix each docs row; keep terminology per `start/concepts.md`.
2. Health, setup-state and checklist changes with tests; portal sidecar filter with a test.
3. Build the docs site and run the link checks.

## Acceptance criteria

- [ ] Every row of the table is fixed; `grep -rn "not macOS-specific\|/djdl/schema" packages/docs docs`
      returns nothing, and the OpenAPI no longer mentions `v1.2.3` as a selector.
- [ ] Worker test: a product with `artifactPolicy.requireDmg: false` and no DMG in its latest
      release has health `healthy`, with no `dmg-arm64`, `dmg-x86_64` or `sparkle-signature` failure.
- [ ] Worker test: djdl-shaped fixtures (no artifact policy) keep today's health results.
- [ ] Admin test: a product with License disabled shows no "Issue a license" checklist item.
- [ ] Worker test: the portal artifact list for a release with `app.dmg`, `app.dmg.sig` and
      `SHA256SUMS.sha256` returns only `app.dmg`.
- [ ] `pnpm --filter @polaris-key/docs check:links` and `docsLinks.test.ts` pass; the green gate passes.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- release portal admin docsLinks
mise exec node@22 -- pnpm --filter @polaris-key/admin test
mise exec node@22 -- pnpm --filter @polaris-key/docs gen:check
mise exec node@22 -- pnpm --filter @polaris-key/docs build && mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

P1-12 (Godot SDK docs) and P2-04 (the declared artifact map) build on accurate release and config
pages. The "ships DMGs" helper is the seam P2-04 replaces with the declared artifact map. When done:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P0-11 done`.
