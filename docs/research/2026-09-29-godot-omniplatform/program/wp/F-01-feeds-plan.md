# F-01 Plan the package-feed model: registry host, `package` deliverables, feed settings, admin API

| Field       | Value                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-1)                                                                                                         |
| Size        | 1–1.5 engineer-weeks                                                                                                                            |
| Depends on  | none                                                                                                                                            |
| Unblocks    | [F-02](F-02-registry-host.md), [F-03](F-03-package-releases.md)                                                                                 |
| Role        | `pkey-wire-planner` (planning only)                                                                                                             |
| Plan mode   | yes: this package **is** the plan. It writes `plans/F-01.md`, then stops for human approval                                                     |
| Gates       | plan mode; human approval (merging the plan PR is the approval)                                                                                 |
| Human input | approval of `plans/F-01.md` and an answer to each open question it raises. The owner decisions of 2026-10-04 are already made; see Design notes |
| Repo        | `vladzaharia/polaris-key`                                                                                                                       |

## Goal

`plans/F-01.md` exists, follows the nine required sections of [`plans/README.md`](../plans/README.md)
and fixes the package-feed model precisely enough for F-02 and F-03 to implement it without a
design decision of their own. It also gives F-04 to F-12 the names they build on: the registry
host's isolation rules, the URL layout, the `package` deliverable kind and its descriptor, the
tables and their owners, the render-on-write mechanism, `authorizeFeedRead`, caching, the
per-ecosystem endpoints and client matrices, how our SDKs get onto the feeds, Swift signing, the
console and admin API, the threat-model additions and the RUNBOOK and DEPLOYMENT changes. A human
merges it. No code, corpus or generated file changes.

## Why

The owner wants Polaris Key to distribute releases a third way: as package-manager feeds it serves
itself, beside direct artifacts and app stores ([S-12 §1](../../notes/S-12-package-feeds.md#1-question)). Feeds add a new
host, a new deliverable kind, a manifest rule (rule 9), migrations, routes (rule 10) and a widened
type allowlist on a same-site host. `CLAUDE.md` requires a plan before a change of that reach, and
the plan must say whether anything touches the wire.

## Read first

- `AGENTS.md` (rules 1–3, 5, 6, 8–10), `CLAUDE.md` (plan mode), `.claude/agents/pkey-wire-planner.md`,
  [`plans/README.md`](../plans/README.md).
- [notes/S-12](../../notes/S-12-package-feeds.md) in full, especially §5 (hosting), §6 (data model), §7 (access), §8
  (security), §10 (work packages, console, admin API) and §11 (decisions).
- [notes/S-13](../../notes/S-13-platform-settings.md) §7 (the Platform section, `#/platform/feeds`).
- Code: `packages/worker/src/core/bytesHost.ts`, `core/blobs.ts` (`BYTES_HOST_TYPES`,
  `NEVER_SERVED`), `dispatch.ts:80`, `mount.ts` (`BYTE_ROUTES`), `core/hooks.ts` (the hook rules),
  `services/distribution/access.ts`, `packages/shared-manifest/src/{index,descriptor}.ts`,
  `migrations/0027_a_release_model.sql`, `packages/docs/scripts/gen-reference.mjs` (`TABLE_OWNERS`),
  `test/routeCoverage.test.ts`, `wrangler.toml`, `packages/cli/src/publish.ts`, the release
  workflows, `sdks/kotlin/build.gradle.kts`, `sdks/swift/Package.swift`.

## Scope

**In:**

- The plan, covering every item listed in the Goal. Each open item is answered with a reason or
  raised as a question with a recommendation (at most three).
- Confirming that the work is not a wire change, or flagging anything that is.
- The list of briefs the plan changes.
- Setting `awaiting-approval`.

**Out** (and where it belongs instead):

- Any code, migration, corpus or generated-file change (→ [F-02](F-02-registry-host.md),
  [F-03](F-03-package-releases.md) and the ecosystem packages).
- Registry credentials (→ [F-20](F-20-registry-credentials-plan.md), which writes its own plan).

## Design notes

**Owner decisions, 2026-10-04 (final; do not relitigate):**

- **Ecosystems:** npm, PyPI, the Swift Package Registry, Maven/Gradle and Godot are required,
  because each has an SDK. Docker/OCI is also required. Cargo, Go and NuGet are tier 3. NuGet
  becomes required if X-01 goes ahead. Rule: a new SDK makes its feed required.
- **Hosting:** self-hosted on the Worker and R2 at `pkg.plrs.im`, the same Worker with isolation
  in the style of `bytesHost`. Custom domains go in `wrangler.toml` per environment.
- **Access:** public read for now. Every read goes through one `authorizeFeedRead`.
- **Public registries:** feeds only. Nothing is published to npmjs, PyPI or Maven Central, and no
  placeholder packages are published.
- **Swift:** releases are signed with an X.509 code-signing certificate, which the owner provides
  later as a CI secret. The pipeline accepts it and fails clearly without it.
- **Console:** one Feeds overview and one page per feed, with a single settings model plus
  per-ecosystem extensions. It is used in two scopes: the Platform section (with S-13's pages)
  and per product when Distribution's `packageFeeds` sub-capability is on.
- **Ownership:** platform packages belong to a reserved system product, `polaris-key`.

## Steps

1. `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --show F-01`. Set `planning`.
2. Read everything in "Read first". Check each S-12 claim against the code, and record any
   corrections.
3. Write the plan section by section, then the questions and the changed briefs.
4. `check.mjs --set F-01 awaiting-approval`, then prettier, then push `wp/F-01-feeds-plan` (the
   lead pushes).

## Acceptance criteria

- [ ] `plans/F-01.md` has the nine required sections.
- [ ] The wire verdict is explicit, surface by surface.
- [ ] Every table has a migration file and a `TABLE_OWNERS` owner. Every manifest rule has a
      mutation-table row. Every route class says how rule 10 applies.
- [ ] Every SDK family is named with its deliverable id, its workflow change and the package that
      does it (F-10).
- [ ] At most three open questions, each with a recommendation.
- [ ] `node check.mjs` passes.

## Verify

```sh
node docs/research/2026-09-29-godot-omniplatform/program/check.mjs
mise exec node@22 -- pnpm exec prettier --check docs/research/2026-09-29-godot-omniplatform/program/plans/F-01.md
```

## Hand-off

- F-02 and F-03 execute the approved plan. F-04 to F-12 take its names. F-20 starts from §6.6.
- The planner sets `awaiting-approval`. The lead sets `done` once the human merges the plan PR.

The role agent sets `--set F-01 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-01 done`.
