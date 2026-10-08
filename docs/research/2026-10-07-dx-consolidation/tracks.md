# DX consolidation: tracks (2026-10-07)

Companion to [`README.md`](README.md) (the plan) and [`backlog-changes.json`](backlog-changes.json)
(the machine-readable edits). The decisions behind every package are in
[`integration.md`](integration.md); file and line evidence is in [`audits/`](audits/).

**Ids.** Every new package uses an id that `check.mjs`'s `ID_RE` already accepts, so new work
goes into existing phases (crosswalk at the end). `integration.md` names the same packages
OB-, AC-, IX-, CFG-, FX-, UC-, CP-, DC-, SDX-, CQW-, CQF- and CQT-; the **Origin** column below
gives that name. For an existing package, Origin is its action in `backlog-changes.json`.

**Flags.** `plan`: plan mode (wire, contract text or client-API contract; the plan is approved
before code). `sec`: security review and THREAT-MODEL rows before merge. `mig`: a D1 migration
whose number the lead assigns at merge (`00XX_<name>.sql`), written to rule 5 below. `window`: run
by the lead in a short window (rule 2). `corpus lane`: holds the serial corpus lane (rule 3).
`deferred`: waits for an owner go. `blocked`: waits for an owner step.

**Weeks** are engineer-weeks (low–high) from `workpackages.json` or the audits' sizing. With 60–90
merges a day they are relative sizes; the binding limits are the serial lanes, plan approvals,
owner steps and two-release contract pairs. "Depends on" lists only open packages, so batch 6
(done) no longer appears.

## Order at a glance

| Track                                                                                                                | Starts                              | Packages | Weeks (required) | Runs beside |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------- | ---------------- | ----------- |
| [A. Ground truth, decisions and quick wins](#a-ground-truth-decisions-and-quick-wins)                                | week 0                              | 5        | 2.4–4.1          | everything  |
| [B. Foundations (code quality the feature tracks build on)](#b-foundations-code-quality-the-feature-tracks-build-on) | as batch 6 lands; two short windows | 35       | 30.6–43.9        | everything  |
| [C. Products, onboarding and Integration](#c-products-onboarding-and-integration)                                    | wave 7                              | 15       | 13.3–18.8        | D, J, K     |
| [D. Administration, access control and console identity](#d-administration-access-control-and-console-identity)      | week 0 (plan), wave 7               | 16       | 12.6–17.8        | C, J        |
| [E. Licensing model](#e-licensing-model)                                                                             | as batch 6 lands (LX-32)            | 27       | 19.6–28          | F, K        |
| [F. Identity](#f-identity)                                                                                           | week 0 (plan), wave 7               | 23       | 19.1–28.8        | E, K        |
| [G. Managed config and Cloud Sync](#g-managed-config-and-cloud-sync)                                                 | week 0 (plan), wave 7               | 22       | 18.1–25.6        | H, I        |
| [H. Distribution channels, storefronts and commerce](#h-distribution-channels-storefronts-and-commerce)              | wave 7                              | 40       | 23.1–34.5        | G, I        |
| [I. Packages, updates and packs](#i-packages-updates-and-packs)                                                      | wave 7                              | 17       | 14.2–21.3        | G, H        |
| [J. SDK and UI-kit consolidation](#j-sdk-and-ui-kit-consolidation)                                                   | week 0 (plans)                      | 26       | 43–61.1          | C, K        |
| [K. Corpus lane (wire trains, serial)](#k-corpus-lane-wire-trains-serial)                                            | as batch 6 lands (P0-44)            | 15       | 11–15.7          | all tracks  |

Packages counts every active package in the track; weeks count the required ones (Track H's
deferred checkout, Track J's SP-38 and Track K's optional members are excluded).

Tracks run in parallel lanes. Within a track, rows are in start order; a row can start as soon
as its dependencies are done, and the lead dispatches from `check.mjs --ready`. Six rules hold
across tracks (integration §4.1):

1. **Batch 6 has landed as built.** LX-08, HA-12, UK-13, UK-14 and ST-36 (`fix/ux-polish-1007`)
   are merged into `integ/batch-6` as reviewed (`2c0525d24`, `6cc235aa3`, `dc3c1dc70`,
   `58ea8ffb8`, `5ad447feb`) and stamped done there (`e4a527fee`). Nothing below reopens them.
2. **Two short lead windows, as early as possible.** The console window (P0-31, then P0-39) runs
   as soon as batch 6 is on main; the worker window (P0-17) runs as soon as P0-15 has merged. Every
   console or worker package that touches moved files depends on its window, so no branch is ever
   in flight across a codemod. P0-44 is a corpus-lane item, not part of either window, and holds
   no non-corpus builder.
3. **The corpus lane is serial** (Track K): a package holds the lane from the moment it
   regenerates the corpus or re-records transcripts until it merges; the rest of its build runs
   beside the lane. SDK waves that only replay the corpus follow their train by dependency. The SDK
   public-API work runs as its own serial lane by dependency: SP-35 → SP-34 → SP-32a → SP-32b →
   SP-39.
4. **No new copies.** No settings page before ST-07, no wizard before ST-39, no admin route
   outside ST-29's table once it lands, no SDK verb outside `api.json` once SP-35 lands, no
   one-off data-migration runner outside P0-49, and no rendering in the old kits once the rebuilt
   kits exist.
5. **Contracts take two releases** (`mig`). `deploy.yml` applies D1 migrations before the Worker
   deploys and D1 runs a migration file with no wrapping transaction, so a table drop must never
   ship with the code that stops reading it. Release N removes every read and write and keeps the
   tables; release N+1 (the `b` packages: U-27b, I-28b, LX-16b, P0-28b, A-27b) drops them after a
   production check that nothing touched them. Every migration is replay-safe (`IF NOT EXISTS`,
   guarded `UPDATE`s), safe for the Worker still serving during the deploy, and ships a down script
   in `scripts/rollback/`; any change to a guarded index ships a new `00XX_index_assertion.sql`.
   Semantic changes (value backfills, resolver switches) run through P0-49 in two releases: N
   materialises explicit values under the old semantics, N+1 switches once the report shows zero
   diffs. Columns in `licenses` and `grants` are left dormant rather than rebuilding those tables
   (`migrations/0017`'s warning).
6. **No compatibility windows** (owner, 2026-10-07). When a 0.9 package replaces a route, mode,
   shape, Action input, CLI form or SDK name, the old one is removed in the same release; a removed
   manifest field is a validator error naming its replacement, and the package migrates the
   repo-root `.pkey/` and `products/djdl/*` in the same change (adopters' repos are owner steps).
   Only three things keep a window, each ending on a production fact recorded in P0-24's ledger:
   - the break-glass `ADMIN_OIDC_*` window, which prevents a console lockout;
   - a path that native app binaries already on end-user machines call (today DJDL's desktop
     builds and the permanent alias routes), removed once DJDL has shipped a build on 0.9;
   - the two-release DB contracts (rule 5), so the Worker still serving during a deploy never
     reads a dropped table.

---

## A. Ground truth, decisions and quick wins

**Order 1 (week 0 to 1).** **Goal:** the graph tells the truth, the owner answers the six open
questions, the U-03 notice stays unstarted, and the cheapest friction is gone before anything
else is built.

| #   | Id    | Origin     | Title                                                                     | Depends on (open) | Weeks   | Flags   |
| --- | ----- | ---------- | ------------------------------------------------------------------------- | ----------------- | ------- | ------- |
| 1   | ST-37 | OB-01      | Vocabulary: one word per concept (rule 4)                                 | —                 | 0.3–0.5 |         |
| 2   | P0-41 | CQF-13     | Living ADMIN.md and PORTAL.md; UX rows registered                         | ST-37             | 0.4–0.6 |         |
| 3   | P0-47 | TrackA-QW1 | Quick wins: console and portal (week 0)                                   | —                 | 0.6–1   |         |
| 4   | P0-48 | TrackA-QW2 | Quick wins: Worker, CLI, CI and docs (week 0)                             | —                 | 0.6–1   |         |
| 5   | A-18k | edit       | Live verification of the storefront credentials and the [U] items of S-15 | —                 | 0.5–1   | blocked |

**Lead actions in the same week (no package):**

1. **Freeze.** Do not set U-03's two production prerequisite flags; confirm with a read-only query
   that `override_migration.notice_started_at` is NULL. Nothing runs by itself
   (`core/overrideMigration.ts:10-22,306`), a notice can be withdrawn before the run, and P0-47
   hides the nav item until U-27.
2. **Graph hygiene** (one PR from current main, `program/README.md` §8 procedure): apply each
   `setStatus` only where main's status differs: stamp the 11 merged packages main has not stamped
   (P1-12, F-10, I-18, PX-W3, PX-20, SP-00, SP-12, SP-17, SP-20, SP-22, SP-23; the other 7 are
   already done in `2eb10597c`), and LX-08, HA-12, UK-13 and UK-14 when batch 6 reaches main;
   apply every merge, split, drop and park in `backlog-changes.json` (parked packages get
   `optional: true` and `deferred: "parked 2026-10-07: <revive condition>"`); register the 140 new
   packages with briefs from `wp/_TEMPLATE.md` (ST-36 as done); retitle phase P0 "Hygiene,
   unblockers and code quality", ST "Settings, access control and console shell", CM "Commerce:
   store commerce (required) and Polaris Key checkout (deferred)", A "Distribution channels and
   store provisioning" and P2 "Release truth, publishing and release tracks"; then
   `--sync-briefs`, `--write-index`, prettier, `node check.mjs`.
3. **Brief amendments before dispatch:** I-08, I-09 and PX-14 rewritten as single specs (I-09
   before I-08 in the train); LX-09 trimmed; LX-10 absorbs LX-21; U-06/07/20/21 on the shipped
   `config.*` names; UK-03 absorbs UK-14's models; UK-06 depends on SP-31; LX-11 gets
   `planRef: CM-20`; every target names the `UX-*` rows it absorbs (`uxRows`).
4. **Dispatch the plans** so no builder waits on one: ST-28, I-27, U-01b, CM-20, LX-41, SP-35,
   P2-12 and UK-02b (and P2-08's documentation row). SP-32a's plan follows SP-35 and SP-34 in the
   SDK lane.
5. **Owner steps:** create the npm org `polaris-key` (no packages); supply A-18k's store
   credentials; grant the GitHub App's optional write permissions (A-32); set
   `PLATFORM_OIDC_MIGRATION=claim` in production before LX-38; run the settings backfill so
   P0-24 can delete it. Add each to `~/Downloads/polaris-key-owner-steps.md`.

**Dependencies:** none. Everything else depends on the hygiene PR (so `--ready` offers the right
work) and on owner decisions 1, 3, 5, 6, 7 and 8 for the packages they gate (decisions 2 and 4
are decided under the brief, README §8).

**Exit criteria:**

- `node check.mjs` passes with every id in `backlog-changes.json` registered and every parked
  package `optional` and deferred; `--critical` no longer routes through a parked kit.
- Every `UX-*` id in EXPERIENCE §13.3, SETUP §8.2 and FLOWS §4.2 is marked from `uxRows` with a
  graph id, a build, a parked revive condition or "dropped" (P0-41, checked by script).
- The six open owner decisions are answered and recorded in `integration.md` §6; decision 1
  before anyone sets the U-03 prerequisite flags.
- The P0-47 and P0-48 quick wins are merged; the boundary and table-crossing tests report today's
  baseline.

---

## B. Foundations (code quality the feature tracks build on)

**Order 2.** **Goal:** one of each shared mechanism (primitives, response module, layering,
route gate, table ownership and audit writer, descriptor contributions, issuance engine,
notifications, data-migration runner, data layer, router, wizard kit, settings engine, generator
registry) so feature work never adds another copy. Everything here is behaviour-preserving.

| #   | Id     | Origin        | Title                                                                 | Depends on (open)   | Weeks   | Flags       |
| --- | ------ | ------------- | --------------------------------------------------------------------- | ------------------- | ------- | ----------- |
| 1   | P0-15  | CQW-01        | Platform primitives and duplicate-helper sweep                        | —                   | 0.6–0.9 |             |
| 2   | P0-16  | CQW-02        | First-party respond and body module for console and portal            | P0-15, P0-17        | 0.5–0.7 |             |
| 3   | P0-21  | CQW-07        | Notification substrate (core/notify)                                  | P0-15, P0-17        | 0.6–0.9 |             |
| 4   | P0-22  | CQW-08        | Request-scoped product context, lazy signer, one hosts table          | P0-17               | 0.5–0.8 |             |
| 5   | P0-29  | CQW-15        | Licence list paging and set queries                                   | P0-15, P0-17        | 0.5–0.8 |             |
| 6   | P0-42  | CQT-01        | Generator registry and pnpm gen                                       | —                   | 1–1.5   |             |
| 7   | P0-43  | CQT-02        | CI consolidation                                                      | P0-42               | 1–1.5   |             |
| 8   | P0-32  | CQF-02        | One data layer for console and portal                                 | P0-39               | 1.2–1.6 |             |
| 9   | P0-34  | CQF-04        | Shared hash-router core                                               | P0-39               | 0.6–0.9 |             |
| 10  | P0-35  | CQF-05        | Vocabularies as data (platforms, ecosystems, licence)                 | P0-39               | 0.5–0.8 |             |
| 11  | ST-39  | OB-03         | Wizard kit                                                            | P0-39               | 1.2–1.6 |             |
| 12  | ST-05a | ST-05 (split) | One settings read and write path                                      | P0-17               | 0.6–0.8 |             |
| 13  | ST-05b | ST-05 (split) | Generic settings routes with bespoke routes as adapters               | ST-05a              | 0.5–0.7 |             |
| 14  | ST-07  | edit          | SettingsRow v2: the one settings engine                               | ST-05a, P0-39       | 0.8–1.1 |             |
| 15  | P0-17  | CQW-03        | Layering move (lead codemod at the batch-6 boundary)                  | P0-15               | 0.8–1.2 | window      |
| 16  | P0-31  | CQF-01        | Console shared-layer cleanup (lead window)                            | —                   | 0.5–0.8 | window      |
| 17  | P0-39  | CQF-10        | Console sections move and page budget (lead window)                   | P0-31               | 0.4–0.6 | window      |
| 18  | P0-44  | CQT-03        | Corpus generator split (corpus lane, right after HA-12)               | —                   | 1.5–2   | corpus lane |
| 19  | ST-29  | AC-02         | Admin route table, can(), useCan and NoAccessPage (absorbs ST-21)     | P0-16, P0-17, ST-28 | 1.4–2   | sec         |
| 20  | P0-18  | CQW-04        | Table ownership, owner stores and one audit writer (absorbs ST-24)    | P0-17               | 1–1.5   |             |
| 21  | P0-19  | CQW-05        | Descriptor contributions and services/<slug>/api.ts facades           | P0-17               | 1–1.4   |             |
| 22  | P0-20  | CQW-06        | Split identity/oidc.ts; extract the issuance engine to core/licensing | P0-17               | 1–1.4   |             |
| 23  | P0-36  | CQF-06        | Portal on the copy catalog                                            | —                   | 0.8–1.2 |             |
| 24  | P0-37  | CQF-07        | Complete the shared component inventory                               | P0-34, P0-35        | 1.5–2   |             |
| 25  | P0-38  | CQF-08        | AuthCard in ui/auth (UX-40)                                           | P0-36               | 0.8–1.1 |             |
| 26  | P0-23  | CQW-09        | Portal off Release's tables                                           | P0-19               | 0.6–0.9 |             |
| 27  | P0-24  | CQW-10        | Migration ledger and one-time machinery sunset                        | P0-18               | 0.4–0.6 |             |
| 28  | P0-49  | CQW-17        | Data-migration runner (dry run, report, apply)                        | P0-17, P0-18        | 0.8–1.2 |             |
| 29  | P0-25  | CQW-11        | Service, portal and public route tables                               | P0-16, P0-19, ST-29 | 1.2–1.8 |             |
| 30  | P0-26  | CQW-12        | Core manifest ingest pipeline                                         | P0-17, P0-18        | 1–1.5   | plan        |
| 31  | P0-30  | CQW-16        | Guardrails, test harness and test layout                              | P0-17, P0-25        | 0.8–1.2 |             |
| 32  | P0-33  | CQF-03        | Worker-owned DTO types for the admin and portal APIs                  | P0-32, P0-17        | 1.5–2   |             |
| 33  | P0-40  | CQF-11        | Console and portal tests and oxlint                                   | P0-33               | 1–1.4   |             |
| 34  | P0-45  | CQT-04        | pkey command registry, context and doctor                             | —                   | 1.5–2   |             |
| 35  | P0-46  | CQT-05        | Lint baselines with debt ledgers                                      | P0-43               | 1–1.5   |             |

**Dependencies:** as batch 6 lands: P0-15, P0-42 (then P0-43 and P0-46), P0-36 (then P0-38),
P0-45, and the lead's console window (P0-31, P0-39). After the console window: P0-32, P0-34,
P0-35, ST-39, and ST-07 once ST-05a is in. After the worker window (P0-17, right behind P0-15):
P0-16, P0-21, P0-22, P0-29, ST-05a → ST-05b, P0-18, P0-19, P0-20, then P0-49 (after P0-18).
ST-29 needs ST-28's approved plan. P0-20 lands before LX-10, LX-35, LX-36, LX-38 and I-08 are
built; P0-19 before ST-40; P0-21 before LX-27, ST-27 and the commerce emails; P0-38 before PX-12,
PX-14, PX-15, PX-21 and ST-30; P0-49 before LX-33, LX-34, LX-35, LX-36, LX-38, LX-39, U-27, U-28,
PS-12, CM-21 and P0-28.

**Exit criteria:**

- Transitive boundary test and table-crossing test blocking; the 13 worker shims, the console
  shims and the A-13 parallel settings system are gone.
- Every admin route is declared in ST-29's table with a capability and an area id; a route x
  principal matrix test covers them all; `isPlatformAdmin`, `canAdminProduct` and
  `hasAnyAdminGrant` no longer exist as separate predicates; `sessionFromRequest()` is called only
  by the dispatcher, and `docs.ts` gates on `can()`.
- One audit writer, one notification substrate, one issuance module (`core/licensing/issue.ts`),
  one data-migration runner (P0-49), one data layer and error class in the console and portal,
  one wizard kit, one settings engine.
- `pnpm gen --check` is the only generator check in CI and `gate.sh`.
- Device transcripts and the corpus are byte-identical throughout.

---

## C. Products, onboarding and Integration

**Order 3.** **Goal:** the owner's headline. Create a product in two or three steps, see in the
console exactly how to connect each feature with code generated for the product, see per
platform when it works, and hide the section by choice.

| #   | Id     | Origin  | Title                                                                               | Depends on (open)     | Weeks   | Flags |
| --- | ------ | ------- | ----------------------------------------------------------------------------------- | --------------------- | ------- | ----- |
| 1   | ST-38  | OB-02   | Service table: five features; one service-off state (absorbs DC-12)                 | —                     | 0.8–1.1 |       |
| 2   | ST-40  | OB-04   | Integration facts and SDK sightings                                                 | P0-19, ST-38, ST-39   | 1–1.5   | mig   |
| 3   | SP-32a | SDX-01  | polaris-key.json: plan, schema, fromConfig() and doctor() in Node, React and Python | SP-35, SP-34          | 1.2–1.6 | plan  |
| 4   | SP-32b | SDX-01b | polaris-key.json, fromConfig() and doctor() in Swift, Kotlin and Godot              | SP-32a                | 1–1.4   |       |
| 5   | SP-33a | SDX-02  | One integration content generator on today's names, and pkey sdk add --expect       | P0-42                 | 1.2–1.5 |       |
| 6   | SP-33b | SDX-02b | Integration content on polaris-key.json in every SDK, the docs and the Godot dock   | SP-33a, SP-32b, SP-35 | 1–1.2   |       |
| 7   | ST-41  | OB-05   | Integration page and Overview card                                                  | ST-40, SP-33a, ST-39  | 1.2–1.6 |       |
| 8   | ST-42  | OB-06   | Create with defaults                                                                | ST-38                 | 0.6–0.9 |       |
| 9   | ST-43  | OB-07   | New Product wizard                                                                  | ST-39, ST-42, P0-26   | 1–1.5   |       |
| 10  | ST-44  | OB-08   | One Home; delete GET /manage/api/summary; slim product list                         | ST-38                 | 0.8–1.2 |       |
| 11  | ST-45  | OB-09   | Platform and Product sidebar contexts                                               | ST-08, ST-29          | 0.6–0.9 |       |
| 12  | ST-46  | OB-10   | Interactive pkey init                                                               | ST-38, P0-45          | 0.4–0.6 |       |
| 13  | ST-47  | OB-11   | Legacy setup retirement                                                             | ST-40, ST-41, ST-44   | 0.5–0.8 |       |
| 14  | SP-36  | SDX-05  | Examples in one tree, built in CI                                                   | SP-32b, SP-33b, P0-43 | 1–1.5   |       |
| 15  | SP-37  | SDX-06  | Developer docs reshape                                                              | SP-33b                | 1–1.5   |       |

**Dependencies:** ST-40 needs P0-19 (descriptor contributions). ST-41 needs only SP-33a, which
registers today's `pkey sdk` renderer as the one generator on the names SDKs ship now; SP-33b
moves the same content to `polaris-key.json` after SP-32b and SP-35, with no page change. ST-42
owns the reserved `default` profile and `distribution.intendedPlatforms` (U-28 and A-20 build on
them); ST-43 needs P0-26 for repo-less ingest; ST-44 builds the server attention read before
ST-47 deletes `productSetupView`; ST-45 needs ST-08 (Track D) and ST-29 (Track B); ST-46 needs
P0-45. The feature cards hosted by ST-41 are built in their own tracks: Licensing (LX-43, E),
Managed config and Cloud Sync (U-32, G), Sign-in (I-36, F), Ship builds (P2-11, I) and Commerce
(CM-23, H). The Integration page is about 6.6 weeks out (P0-15 → P0-17 → P0-19 → ST-40 → ST-41,
upper estimates).

**Exit criteria:**

- A new product is created in two or three wizard steps in one D1 batch (key, Default profile,
  catalog v1, Free tier, services, trust policy, planned platforms) and lands on Integration.
- Integration shows, per enabled feature, its prerequisites, a snippet from the one generator and
  Verified per platform; Verified is the feature's `sdk_sightings` bit once its prerequisites are
  met (first CI package publish and updater Wired are the only domain facts); "Hide Integration"
  appears after the first Verified feature, is recorded in `core.setup`, and never happens
  automatically: no product is hidden without an operator's choice, the backfill included.
- `sdk_sightings` adds no wire field, writes at most once per key per isolate every 5 minutes and
  is pruned at 90 days.
- One Home (no Products page, no `GET /manage/api/summary`, attention from one server read);
  Platform and Product sidebars switch by context; Welcome, TrustPanel, the Overview checklist,
  `nextActions` and the `onboarding` payload are deleted; the product card is still ST-36's.
- D-02 dogfoods the wizard and Integration page on Diceroll.

---

## D. Administration, access control and console identity

**Order 3.** **Goal:** operators are Polaris Key accounts with the owner's four built-in roles,
summed and enforced on every admin route; SSO groups, verified domains and claims map to roles;
Platform settings are ordered by how often they change; the CLI runs on personal tokens.

| #   | Id    | Origin | Title                                                                 | Depends on (open)    | Weeks    | Flags     |
| --- | ----- | ------ | --------------------------------------------------------------------- | -------------------- | -------- | --------- |
| 1   | ST-28 | AC-01  | Plan: console RBAC and console identity on accounts                   | —                    | 0.6–0.8  | plan, sec |
| 2   | ST-30 | AC-03  | Console sign-in on Polaris Key accounts                               | ST-29, P0-38         | 1.2–1.8  | sec       |
| 3   | ST-31 | AC-04  | Roles, bindings, invites and the Members pages (absorbs ST-22)        | ST-30                | 1.4–2    | sec, mig  |
| 4   | ST-32 | AC-05  | SSO rules and the adminGroup conversion                               | ST-31, I-30          | 0.8–1.1  | sec       |
| 5   | ST-34 | AC-07  | Admin-scope personal tokens and pkey login                            | F-33, ST-30, P0-45   | 1–1.4    | sec       |
| 6   | ST-35 | AC-08  | RBAC docs, lockout recovery, docs-gate split and adminGroup contract  | ST-31, ST-32         | 0.4–0.6  | sec       |
| 7   | ST-08 | edit   | Product settings hub: Services, Presentation, Keys & secrets, Members | ST-07                | 1.2–1.7  |           |
| 8   | ST-09 | edit   | Platform settings ordered by use                                      | ST-07                | 1–1.4    |           |
| 9   | ST-10 | edit   | Cmd-K settings search, permission-filtered                            | ST-08, ST-29         | 0.4–0.55 |           |
| 10  | ST-11 | keep   | SQL-only settings into the registry                                   | ST-09, ST-05a        | 0.6–0.85 |           |
| 11  | ST-12 | edit   | Device trust policy editor                                            | ST-08, ST-09         | 0.9–1.25 |           |
| 12  | ST-14 | edit   | Customer portal settings: three keys                                  | ST-08, I-29          | 0.7–1    |           |
| 13  | ST-16 | edit   | Live platform defaults with fan-out confirm (trimmed)                 | ST-09                | 0.6–0.85 |           |
| 14  | ST-17 | edit   | Resync dry-run on the core ingest pipeline                            | ST-08, P0-26         | 0.8–1.1  |           |
| 15  | ST-25 | edit   | Legacy settings retirement (widened)                                  | ST-11, ST-14, ST-17  | 0.4–0.55 |           |
| 16  | ST-27 | edit   | Notification destinations on core/notify                              | ST-09, P0-21, ST-05a | 0.6–0.85 |           |

**Dependencies:** console on accounts is decided under the brief (owner brief "Console/Management
accounts go through the same accounts system"; README §8, D2), so ST-30 and ST-34 are not gated.
ST-29 (the gate, Track B) puts `docs.ts` on `can()` before ST-30 issues any non-admin session.
ST-30 needs P0-38 (AuthCard) and covers the seeded env Pocket ID console IdP and passkeys;
identifier-first routing of operators to their own SSO connection, and console domain rules, are
ST-32's and wait for I-30's DNS-verified, enforced connections. ST-34 needs F-33 (the
`account_tokens` table, Track I) and P0-45. ST-08 needs ST-07 (Track B); ST-14 waits for I-29
(Track F) so the retired portal toggles are never registered; ST-17 needs P0-26. ST-16 no longer
waits for U-05. ST-33 (requests) is not built: NoAccessPage lists the scope's admins to contact,
which is what the brief asks for.

**Exit criteria:**

- Every current `PLATFORM_ADMIN_GROUP` member signs in as Superadmin with no setup; the root rule
  cannot be removed; break-glass (`ADMIN_OIDC_*`) stays at least 30 days and goes only after 14
  days with no break-glass sign-in and at least two Superadmins on passkeys (RUNBOOK, P0-24).
- Four built-in roles sum (Superadmin, Platform admin, Product admin, Console access); a Product
  admin binding can be narrowed to areas, which are stable ids on routes, not sidebar sections; a
  member with only Console access sees NoAccessPage with the scope's admins, never a dead end.
- The strong-method rule holds: an email code alone never opens the console, and a method added
  during a session that was not strong counts only after step-up; grants need step-up and are
  audited and notified.
- `core.adminGroup`, `products.admin_group` and manifest `product.adminGroup` are retired after
  the conversion offer; `PKEY_ADMIN_COOKIE` is gone from the CLI and docs in the release that
  ships ST-34's tokens (rule 6); admin and packages tokens are exclusive.
- Platform settings render every registered key, ordered by use; the docs gate admits Platform
  admins from ST-29 and any active console member from ST-35, with operator sections behind
  Platform admin.

---

## E. Licensing model

**Order 4.** **Goal:** the owner's licence model with fewer layers: a licence is in an account,
waiting or floating; every licence has a tier, its template; add-ons are sub-licences; limits
resolve licence > tier > platform default through one resolver, exactly the brief's chain; one
access policy decides automatic licences; durations support trials, keeps-the-last-version and
subscriptions that work without Commerce; licensing settings go from 7 to 1.

| #   | Id     | Origin | Title                                                                                            | Depends on (open)                              | Weeks    | Flags              |
| --- | ------ | ------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- | -------- | ------------------ |
| 1   | LX-32  | new    | One resolver for licence limits and duration                                                     | —                                              | 0.6–0.9  |                    |
| 2   | LX-33  | new    | Licence > tier > platform default for every limit; every licence has a tier                      | LX-32, P0-49                                   | 1–1.4    | mig                |
| 3   | LX-34  | new    | Entitlement catalog in Licensing; tier entitlements; platform entitlements (absorbs CFG-06)      | LX-33, P0-49                                   | 1.2–1.6  |                    |
| 4   | U-28   | CFG-02 | One config chain: Default profile, one profile per tier, no device layer                         | U-27, LX-34, ST-42, P0-49                      | 1–1.4    | mig                |
| 5   | LX-09  | edit   | Entitlement composition, trimmed: one model and a one-time switch                                | LX-34                                          | 1–1.4    |                    |
| 6   | LX-35  | new    | Add-on definitions and grantAddOn                                                                | LX-34, P0-20, P0-49                            | 1–1.4    |                    |
| 7   | LX-44  | new    | License console v2: Tiers and Entitlements pages                                                 | LX-34, LX-35, ST-07                            | 0.8–1.2  |                    |
| 8   | LX-36  | new    | Access policy license.access (absorbs PS-09)                                                     | LX-35, P0-20, P0-49                            | 1–1.4    | sec                |
| 9   | LX-40  | new    | Retire the licensing-model settings (7 to 1)                                                     | LX-09, LX-10, LX-12, LX-05b                    | 0.3–0.5  |                    |
| 10  | LX-38  | new    | Account-keyed automatic licences; Discover for every account                                     | LX-36, P0-20, P0-49                            | 0.8–1.2  | sec                |
| 11  | LX-10  | edit   | One rankLicenses() with version-aware re-homing (absorbs LX-21)                                  | LX-09, I-09, P0-20                             | 0.5–0.7  |                    |
| 12  | LX-12  | edit   | Licence and add-on lifecycle states (no refund grace)                                            | —                                              | 0.4–0.55 |                    |
| 13  | LX-41  | new    | Durations and subscriptions core: trials, onExpiry keepVersion, licenseState, Core subscriptions | LX-33, LX-12                                   | 2–2.8    | plan, sec, mig     |
| 14  | LX-11  | edit   | Store bindings on offers and add-ons (executes CM-20's plan)                                     | LX-10, CM-20, LX-35                            | 1–1.4    | plan               |
| 15  | LX-23  | edit   | Store subscriptions: Apple and Play on Core subscriptions (required)                             | LX-11, LX-12, LX-41                            | 1.4–1.95 | plan, now required |
| 16  | LX-13  | edit   | Developer backend for entitlements and add-on grants                                             | LX-09                                          | 0.6–0.85 |                    |
| 17  | LX-14  | edit   | Licence record: Status, Entitlements, Keys, Devices, Activity                                    | LX-09, LX-10, LX-11, LX-12                     | 0.7–1    |                    |
| 18  | LX-15  | edit   | Portal licensing: duration line, add-ons and Automatic grant                                     | LX-09, LX-10, LX-41, P0-36                     | 0.5–0.7  |                    |
| 19  | LX-27  | edit   | Create a licence: device limit and invitation delivery                                           | P0-21                                          | 0.5–0.8  |                    |
| 20  | LX-29  | edit   | New License wizard on the wizard kit                                                             | LX-27, ST-39, LX-32                            | 1–1.5    |                    |
| 21  | LX-31  | edit   | Licence holders and automatic licences close-out                                                 | LX-29, UK-42, LX-39, UK-43                     | 0.4–0.6  |                    |
| 22  | LX-39  | new    | Licences in an account need sign-in, per product once its SDKs support it                        | I-09, I-10a, I-10b, ST-40, LX-27, P0-49        | 0.4–0.6  | plan, corpus lane  |
| 23  | LX-43  | new    | Licensing presets, the 1.x helper, the new-major callout and the Integration Licensing card      | LX-41, LX-44, ST-41                            | 0.8–1.1  |                    |
| 24  | LX-05b | keep   | Reserved entitlement names, error phase                                                          | —                                              | 0.1–0.15 |                    |
| 25  | LX-22  | edit   | Licensing close-out on the new glossary                                                          | LX-09, LX-11, LX-13                            | 0.3–0.4  |                    |
| 26  | LX-16  | edit   | Licensing contract step (widened)                                                                | LX-09, LX-11, U-28, LX-36, LX-38, LX-40, PS-12 | 0.2–0.3  |                    |
| 27  | LX-16b | new    | Licensing contract drops (release N+1)                                                           | LX-16                                          | 0.1–0.2  | mig                |

**Dependencies:** LX-08 is done (batch 6). Every value-changing step runs through P0-49's runner
in two releases (rule 5): LX-33 (tierless licences onto a Default tier; channel and window values
materialised before the resolver switches), LX-34 (entitlement buckets), LX-35 (add-ons, consuming
`dist_store_product_entitlements`), LX-36 (access rules, converting LX-08's `grt_oidc_*` grants),
LX-38 (a duplicate check before its unique index). LX-34 no longer waits for U-28 or owner
decision 1. LX-35, LX-36 and LX-38 build on P0-20's issuance module (Track B). LX-38 needs the
owner step `PLATFORM_OIDC_MIGRATION=claim`. LX-11 executes CM-20's plan (Track K) and retires
LX-08's catch-up and dual-write. LX-39 flips `license_owned` per product from `sdk_sightings`
(ST-40) once I-10a/b exist, holding the corpus lane for its contract text; LX-31 sets the global
default after the rebuilt kits (UK-42, UK-43). The wire members (the duration member with trials,
add-on grants, consumables, reasons) ride LX-18 in Track K; LX-42 is a required member. LX-43
plugs its card into ST-41 (Track C). The automatic-licences editor is on P2-10's product Access
page (Track I). LX-16 waits for every migration it would otherwise strand (U-28, LX-36, LX-38,
LX-40, PS-12); LX-16b drops the standalone tables a release later; `licenses.sub` retires only in
I-32's post-sunset contract.

**Exit criteria:**

- One limits resolver with sources; signed documents byte-identical across LX-32 and across
  LX-33's switch; channels are matched as stored (WIRE-CONTRACT-V4 §5.1 rule 4) and "dev includes
  beta" is applied by the editors at write time; no tierless licence remains.
- Entitlements are declared in Licensing (`licensing.entitlements[]`, kinds feature, quantity,
  consumable); `/config/schema` still serves `flag` rows (no wire change); tiers own entitlements
  and name at most one profile; every grant references an add-on.
- `license.access` replaces `license.autoIssue`, the group map's tier half, `syncTierOnSignIn`,
  `groupLabels` and PS-09; automatic licences are account-keyed, mint no key, bind the device and
  are unique per account and product under concurrency; Discover works for every account.
- Subscriptions run from manual and external sources with Commerce off; a trial converts to its
  tier with no operator step; a lapsed keeps-the-last-version licence runs its fallback version
  forever; consumables keep a redemption ledger.
- The registry holds one licensing setting (`license.dunningGraceDays`); LX-16 has stopped every
  legacy read and LX-16b has dropped the standalone tables, with the rollback ladder in P0-24.

---

## F. Identity

**Order 4.** **Goal:** one account with many ways in; connections routed by verified email
domain; one OAuth-shaped authorization server per product; profile v2 with screen name and an
optional birth date; consent that can be scoped.

| #   | Id      | Origin | Title                                                                            | Depends on (open)        | Weeks    | Flags          |
| --- | ------- | ------ | -------------------------------------------------------------------------------- | ------------------------ | -------- | -------------- |
| 1   | I-28    | IX-01  | Accounts contract phase                                                          | P0-17                    | 0.4–0.6  |                |
| 2   | I-28b   | IX-01b | Accounts contract drops (release N+1)                                            | I-28                     | 0.1–0.2  | mig            |
| 3   | I-29    | IX-02  | Retire per-product account toggles; one App sign-in page                         | ST-38, I-30              | 0.5–0.8  |                |
| 4   | I-30    | IX-03  | Connections: one OIDC relying-party client, verified domains, identifier routing | I-27, P0-15              | 2.5–3.5  | sec, mig       |
| 5   | I-31    | IX-04  | Platform -> Connections and setup wizards                                        | I-30, ST-09, ST-39       | 1–1.4    | sec            |
| 6   | I-33    | IX-08  | Profile v2: screen name, birth date, platform terms                              | I-27                     | 0.8–1.2  | mig            |
| 7   | I-35    | IX-10  | One identity: manifest block (joint with LX-36)                                  | I-27, I-09, LX-36        | 0.8–1.2  |                |
| 8   | I-34    | IX-09  | Granular consent and Connected apps                                              | I-08, I-11, I-35         | 0.8–1.2  |                |
| 9   | PX-12   | edit   | Login card v2 on the AuthCard                                                    | P0-38, P0-36             | 0.4–0.8  |                |
| 10  | PX-14   | edit   | Passthrough card header and scoped consent                                       | PX-12, I-08, I-15, P0-38 | 0.4–0.8  |                |
| 11  | PX-15   | edit   | After sign-in: add a method, link accounts, approve a device                     | PX-12, P0-38             | 0.4–0.8  |                |
| 12  | PX-21   | edit   | FinishStep: email gate, profile and terms for every new account                  | PX-12, I-33, P0-38       | 0.4–0.8  |                |
| 13  | PX-W13b | edit   | Display-name policy on the presentation name                                     | —                        | 0.3–0.6  |                |
| 14  | PX-W19  | edit   | Account v2 gaps, Worker and controls (absorbs PX-25)                             | —                        | 0.4–0.8  |                |
| 15  | I-36    | IX-11  | Sign-in Integration card                                                         | I-08, I-29, I-35, ST-41  | 0.6–1    |                |
| 16  | I-13    | edit   | Token exchange for store and product-connection kinds                            | I-10a, I-10b, I-30       | 1–1.4    | plan           |
| 17  | I-14    | edit   | Game and store sign-in derived from channels                                     | I-13                     | 1.6–2.25 |                |
| 18  | I-15    | keep   | Native redirect sign-in                                                          | I-08, I-10a, I-10b       | 0.8–1.1  | plan           |
| 19  | I-32    | IX-05  | Product connections (absorbs I-22)                                               | I-30, I-08, I-13, I-35   | 1.4–2    | plan, sec, mig |
| 20  | I-11    | edit   | Account data lifecycle: export, removal, support code, revocation hook           | I-09                     | 1.6–2.25 |                |
| 21  | I-19    | edit   | Identity and portal docs (absorbs PX-19)                                         | I-10a, I-10b, I-11, I-14 | 0.6–0.85 |                |
| 22  | I-20    | edit   | Plan layer 2 on I-08's endpoints (re-scoped)                                     | I-10a, I-10b, I-11       | 0.4–0.6  | plan           |
| 23  | I-21    | edit   | Sign in with <Product> on the OAuth-shaped endpoints                             | I-20                     | 1.9–2.6  | plan           |

**Dependencies:** I-27 (the plan) and I-09 → I-08 → I-10a/I-10b run in Track K (corpus lane).
I-28 needs P0-17's window; I-28b drops the `portal_*` tables a release later. I-29 waits for
I-30's per-domain enforce, so a product that turned magic link off keeps SSO-only sign-in, and
must precede ST-14. I-30 needs I-27's approved connection model. I-32 needs I-08, I-13 and I-35.
PX-12/14/15/21 build on P0-38 (AuthCard, Track B). I-36 plugs into ST-41 (Track C). The end-user
Pocket ID sunset waits until Pocket ID runs as a connection (I-30) and djdl's group mapping lives
in `license.access` rules (LX-36).

**Exit criteria:**

- Six OIDC relying-party code sites become one; platform SSO routes by DNS-verified domain with
  optional enforce; magic link is always available otherwise.
- The four per-product portal toggles and `releases_enabled` are unread and never registered; one
  App sign-in page; one Platform → Connections page with no policy knobs.
- New accounts finish through one FinishStep with screen name, an optional birth date (never sent
  to apps) and platform terms recorded.
- Consent posts a granted subset; Connected apps can change or revoke what an app gets.
- Custom product issuers have migrated to product connections; no second authorization-server
  tree, no I-22 kinds, no `identity.native`.

---

## G. Managed config and Cloud Sync

**Order 5.** **Goal:** three config entry types with in-app visibility, one five-layer chain the
console never re-derives, minted tokens declared once, and Cloud Sync built on the shipped
config API with one records store whose v1 SDK surface is saves.

| #   | Id    | Origin  | Title                                                                                   | Depends on (open)                    | Weeks    | Flags |
| --- | ----- | ------- | --------------------------------------------------------------------------------------- | ------------------------------------ | -------- | ----- |
| 1   | U-27  | CFG-01  | Keep the licence config layer; delete the override-migration machinery                  | P0-49                                | 0.6–0.9  | mig   |
| 2   | U-27b | CFG-01b | Drop the override-migration tables (release N+1)                                        | U-27                                 | 0.1–0.2  | mig   |
| 3   | U-29  | CFG-03  | Effective config with provenance                                                        | U-28                                 | 0.5–0.7  |       |
| 4   | U-30  | CFG-04  | Config types and in-app visibility in one vocabulary                                    | —                                    | 0.6–0.8  |       |
| 5   | U-31  | CFG-05  | Minted tokens carry their recipe                                                        | U-30                                 | 0.9–1.2  | sec   |
| 6   | U-32  | CFG-07  | Catalog templates, Cloud Sync page, minted-token wizard and the Integration config card | U-30, U-31, U-06, ST-39, ST-41       | 0.8–1.1  |       |
| 7   | U-01b | new     | Cloud Sync plan amendment: two stores, one conflict vocabulary, quota as an entitlement | —                                    | 0.4–0.6  | plan  |
| 8   | U-05  | edit    | Cloud Sync service and routes per U-01b                                                 | I-08, U-01b, P0-25                   | 2–2.8    | plan  |
| 9   | U-19  | keep    | Security review of U-05 before any production deploy                                    | U-05                                 | 0.4–0.55 |       |
| 10  | U-06  | edit    | Synced settings on config.\* in Node and Python                                         | U-05, I-10a, SP-35                   | 1–1.4    | plan  |
| 11  | U-07  | edit    | Synced settings on config.\* in Swift and Kotlin                                        | U-05, I-10b, SP-35                   | 1.4–1.95 | plan  |
| 12  | U-20  | edit    | Synced settings on config.\* in React                                                   | U-05, I-10a, I-08, SP-35, SP-31      | 1–1.4    | plan  |
| 13  | U-21  | edit    | Synced settings on config.\* in Godot                                                   | U-05, I-10b, SP-35                   | 1–1.4    | plan  |
| 14  | U-09  | edit    | Records store with the saves template (absorbs U-24b)                                   | U-05, U-19, U-01b                    | 1.2–1.7  | plan  |
| 15  | U-10  | edit    | Files on records (absorbs U-24a)                                                        | U-05, U-19, U-09, U-01b              | 1.4–1.95 | plan  |
| 16  | U-12  | edit    | Cloud Sync privacy cascade (Worker)                                                     | U-05, I-11                           | 0.8–1.1  |       |
| 17  | U-11a | edit    | Users -> Data tab (absorbs U-11b, U-11c)                                                | U-05, ST-08, U-29, U-09, U-10, ST-07 | 0.6–0.85 |       |
| 18  | PX-18 | edit    | Portal Cloud Sync section (absorbs PX-W11)                                              | U-05, U-12                           | 0.4–0.8  |       |
| 19  | U-15a | edit    | Cloud Sync developer guide (absorbs U-15b)                                              | U-06, U-21                           | 0.4–0.55 |       |
| 20  | U-22  | edit    | Saves SDK on the records store: Node, React, Python (absorbs U-13)                      | U-09, U-08                           | 1–1.4    | plan  |
| 21  | U-23  | edit    | Saves SDK on the records store: Swift, Kotlin, Godot (absorbs U-25)                     | U-09, U-08                           | 1.2–1.7  | plan  |
| 22  | U-08  | edit    | One conflict vocabulary and MergeRequest in six SDKs                                    | U-06, U-07, U-20, U-21               | 0.4–0.55 | plan  |

**Dependencies:** U-27 needs owner decision 1 and the week-0 read-only check; it removes every
read of `override_migration` (including `payload.ts:125`) and U-27b drops the tables a release
later. If the owner keeps the U-03 run, U-27 shrinks to deleting the machinery after the 90-day
report, and U-28 materialises profile stacks into account overrides for licences that have an
owner. U-28 (listed in Track E) builds on ST-42's reserved Default profile. U-01b (plan) gates
U-05, U-09 and U-10; its appended `sync-scenarios.json` rows and U-05's `sync-*` transcripts take
the corpus lane's W-SYNC slot. U-05 is born on P0-25's route tables and needs I-08 (Track K).
U-06/07/20/21 need SP-35's names (Track J). U-32 plugs its card into ST-41.

**Exit criteria:**

- The server chain is catalog defaults → Default profile → tier profile → licence overrides →
  account overrides; the device layer and licence profile stacks are gone; the override
  migration machinery (about 3,000 lines, 2 tables) is deleted across U-27 and U-27b.
- One admin read returns each key's effective value with provenance; `resolveInherited` is
  deleted and the lock bug cannot recur.
- The console shows Type (Setting, Secret, Minted token) and In the app (Editable, Read-only,
  Hidden); minted tokens carry their recipe in the catalog; served documents unchanged.
- Synced settings use `config.set/clear/setting/onConfigChange` in all six SDKs (no
  `setConfig`/`clearConfig`/`settingState`); saves ship on one records store with files; one
  conflict vocabulary; the quota is the `pkey.cloudSync.bytes` entitlement, with one ceiling and
  `writesPaused`.
- U-19's security review passes before any production deploy.

---

## H. Distribution channels, storefronts and commerce

**Order 5.** **Goal:** show only the channels a product can use; one page per channel with its
delivery and sales facets; automatic setup from credentials already held; one Offer, SKU and
Purchase model across storefronts; subscriptions and refunds that keep licences in sync.

| #   | Id     | Origin  | Title                                                                         | Depends on (open)                 | Weeks   | Flags                    |
| --- | ------ | ------- | ----------------------------------------------------------------------------- | --------------------------------- | ------- | ------------------------ |
| 1   | A-19   | DC-02   | One channel catalogue (tools/channels.json)                                   | ST-37                             | 1–1.4   |                          |
| 2   | A-20   | DC-03   | Product facts and the channel read model                                      | A-19, ST-42                       | 0.8–1.2 |                          |
| 3   | A-28   | DC-11   | One store-app binding with derived identity                                   | A-19                              | 0.6–0.9 |                          |
| 4   | A-22   | DC-05   | The channel page (Status, Releases, Listing, Sales, Setup)                    | A-20, A-28                        | 1.4–2   |                          |
| 5   | A-21   | DC-04   | Console IA: Distribution and Commerce groups                                  | A-20, A-22                        | 0.6–0.9 |                          |
| 6   | A-23   | DC-06   | Channel setup: wizards and the setup runner                                   | A-22, ST-39, A-28, P0-27          | 1.4–2   |                          |
| 7   | A-33   | DC-06b  | Channels enable in one confirmation; a storefront activates with its channel  | A-23, P0-28                       | 0.6–0.9 |                          |
| 8   | A-24   | DC-07   | Publish everywhere and the verb facade                                        | A-22                              | 1–1.4   | sec                      |
| 9   | A-25   | DC-08   | Action v2: channels auto and thin inputs (absorbs CQS-10)                     | A-19, P0-45                       | 1–1.4   |                          |
| 10  | A-26   | DC-09   | Customer channel actions                                                      | A-19, A-20                        | 0.6–0.9 |                          |
| 11  | A-27   | DC-10   | One listing truth (absorbs ST-13)                                             | A-19                              | 0.8–1.2 | mig                      |
| 12  | A-27b  | DC-10b  | Drop the dist_listing table (release N+1)                                     | A-27                              | 0.1–0.2 | mig                      |
| 13  | A-29   | DC-14   | Homebrew formula for CLI archives                                             | A-19                              | 0.4–0.6 |                          |
| 14  | A-30   | DC-15   | Generated SHA256SUMS                                                          | —                                 | 0.3–0.5 |                          |
| 15  | A-31   | DC-16   | Derived identities and a short .pkey/distribution                             | A-19, A-20, A-28                  | 0.8–1.2 | plan                     |
| 16  | A-32   | DC-17   | GitHub write path and Publish from CI                                         | ST-39, A-25                       | 1–1.4   | sec                      |
| 17  | CM-21  | new     | Storefront connection: notifications automation and one test-purchase switch  | CM-20, A-28, P0-49                | 0.6–0.9 | sec                      |
| 18  | CM-22  | new     | Purchases ledger and one revocation path                                      | LX-11, LX-12                      | 0.8–1.2 |                          |
| 19  | CM-23  | new     | Console commerce: Offers, Purchases and the Sales tab                         | CM-21, CM-22, LX-11, A-22, LX-35  | 1.4–2   |                          |
| 20  | CM-24  | new     | One Steam ownership engine (absorbs PS-07)                                    | LX-11, LX-35                      | 0.7–1.1 |                          |
| 21  | CM-26  | new     | Portal Account -> Purchases across storefronts                                | CM-22, LX-15                      | 0.6–0.9 |                          |
| 22  | CM-25  | new     | App purchase as a licence source                                              | CM-20, LX-11, LX-10, CM-22        | 1–1.5   | plan, sec                |
| 23  | CM-27  | new     | Spike: store purchase parity (Microsoft Store, itch.io, consumables)          | —                                 | 0.3–0.5 |                          |
| 24  | CM-28  | new     | Consumables and quantity grants from store purchases                          | CM-27, CM-22, LX-42               | 0.8–1.2 | plan, sec                |
| 25  | PS-12  | new     | Discover visibility: one setting                                              | LX-36, P0-49                      | 0.3–0.5 |                          |
| 26  | P0-27  | CQW-13  | One adapter per store (delivery and commerce facets)                          | A-19, P0-17                       | 1.2–1.8 |                          |
| 27  | P0-28  | CQW-14  | One sealed credential store and resolver                                      | P0-18, P0-27, P0-49               | 1.5–2   | plan, sec, mig           |
| 28  | P0-28b | CQW-14b | Drop the old credential stores (release N+1)                                  | P0-28                             | 0.1–0.2 | sec, mig                 |
| 29  | PX-09  | edit    | Get it: every channel action per platform                                     | A-26, HA-09, P0-35                | 0.4–0.8 |                          |
| 30  | PS-05b | edit    | Storefront library entries                                                    | A-26                              | 0.4–0.8 |                          |
| 31  | PS-11  | edit    | Storefront close-out                                                          | PS-12                             | 0.4–0.6 |                          |
| 32  | HA-09  | keep    | Portal licensed downloads prefer the mirrored R2 copy with PX-W3's download … | —                                 | 0.2–0.4 |                          |
| 33  | CM-01  | edit    | Polaris Key checkout plan, reduced (deferred)                                 | —                                 | 0.6–0.9 | plan, deferred, optional |
| 34  | CM-02  | edit    | Stripe as the Polaris Key storefront's commerce facet (absorbs CM-03)         | CM-01, P0-27, P0-28               | 1–1.4   | deferred, optional       |
| 35  | CM-04  | edit    | Polaris Key prices and coupons on offers (absorbs CM-09, CM-16)               | CM-02                             | 1–1.4   | deferred, optional       |
| 36  | CM-05  | edit    | Checkout fulfilment and reversal (absorbs CM-06)                              | CM-04, LX-09, LX-10, LX-12, LX-13 | 1.2–1.6 | deferred, optional       |
| 37  | CM-08  | edit    | Polaris Key subscriptions on Core subscriptions (absorbs CM-07)               | LX-23, CM-05, LX-41               | 1.4–1.9 | deferred, optional       |
| 38  | CM-11  | edit    | Portal Polaris Key orders on Account -> Purchases                             | CM-08, LX-15, CM-26               | 1.2–1.6 | deferred, optional       |
| 39  | CM-12  | edit    | Polaris Key Sales tab content                                                 | CM-08, LX-14, CM-23, CM-04        | 1.2–1.6 | deferred, optional       |
| 40  | CM-17  | keep    | Commerce close-out                                                            | CM-11, CM-12, CM-15               | 0.8–1.2 | deferred, optional       |

**Dependencies:** A-19 needs ST-37's vocabulary; A-20 reads ST-42's `intendedPlatforms`. A-23
needs ST-39 (wizard kit) and P0-27 (each adapter's `requirements()`), not A-18k: non-store
channels (Homebrew, winget, Scoop, package feeds, Polaris Key) automate at once, and each store's
rows stay human steps until A-18k verifies that store. A-33 ("one click" and auto-activation)
reads P0-28's `resolveCredential`, so there is no fifth credential reader. A-25 needs P0-45.
CM-20 (plan, Track K) gates LX-11 and CM-21; CM-22 needs LX-11 and LX-12 (Track E); CM-23 needs
LX-35. P0-27 needs A-19; P0-28 lands before CM-02 and P0-28b drops the old stores a release
later; A-27b drops `dist_listing` a release after A-27. CM-01..CM-19 (Polaris Key checkout) stay
deferred until owner decision 5; on a "go", the reduced v1 (CM-01, 02, 04, 05, 08, 11, 12, 14,
15, 17) re-plans on CM-20.

**Exit criteria:**

- One channel catalogue (`tools/channels.json`) generated into worker, console, portal and CLI
  with a two-way adapter conformance test; about nine label tables deleted.
- A Windows-only product sees no Apple channel or storefront anywhere, and an arm64-only build
  offers no x64 artefact; a channel whose credentials are already held enables with one
  confirmation; a channel and its storefront activate together when one credential serves both.
- Each facet uses four states (Not set up, Ready, Live, Attention); Distribution has Overview,
  Rollouts, Health, Channels and Packages; Commerce has one Storefronts overview, Offers and
  Purchases; eight legacy items redirect.
- An offer is defined once and sold as SKUs on several storefronts, priced from one base price
  with each store's tools under a typed confirmation; every refund path goes through one
  `revokePurchase`; store identities are derived from the platform pin, never typed.
- One release reaches every live channel from one Publish dialog; Halt everywhere includes the
  stores; production store submission stays one typed click.

---

## I. Packages, updates and packs

**Order 5.** **Goal:** one personal token per person across feeds; feeds that provision
themselves securely; automatic cleanup; stable, beta and dev release tracks built in with
promote and demote; one product Access page; updater setup scoped to shipped platforms and
verified; packs that ship themselves.

| #   | Id    | Origin | Title                                                          | Depends on (open)         | Weeks   | Flags    |
| --- | ----- | ------ | -------------------------------------------------------------- | ------------------------- | ------- | -------- |
| 1   | F-33  | FX-01  | Personal tokens (pkeyp\_, packages:read) and portal Packages   | P0-17                     | 1.2–1.6 | sec, mig |
| 2   | F-34  | FX-02  | Feeds that provision themselves, Customers by default          | F-33                      | 0.8–1.1 | sec      |
| 3   | F-37  | FX-05  | pkey feeds setup --write and CLI naming                        | F-33                      | 0.5–0.8 |          |
| 4   | P2-08 | UC-01  | Built-in dev release track and default store track maps        | —                         | 0.5–0.8 | plan     |
| 5   | F-36  | FX-04  | Feed cleanup on by default (dev and main prereleases)          | P2-08                     | 0.3–0.5 | sec      |
| 6   | P2-09 | UC-02  | Demote a release down a release track                          | P2-08                     | 0.5–0.8 | mig      |
| 7   | P2-10 | UC-03  | Product Access page: who gets what (absorbs LX-37)             | ST-07, F-34, LX-36, ST-39 | 1–1.4   |          |
| 8   | P2-11 | UC-04  | Updates page: updaters for shipped platforms with Wired status | P2-08, A-20               | 0.8–1.1 |          |
| 9   | P2-13 | UC-07  | Portal channel picker and SHA-256                              | P2-08, A-26, A-30         | 0.4–0.6 |          |
| 10  | F-35  | FX-03  | Publish to public registries (absorbs DC-13)                   | F-34                      | 1.2–1.6 | sec      |
| 11  | P4-33 | CP-01  | Pack transports auto                                           | A-25                      | 0.6–0.9 |          |
| 12  | P4-34 | CP-02  | One-click pack gate and the packs-without-Update warning       | P2-10, LX-35              | 0.4–0.6 |          |
| 13  | D-01  | keep   | Diceroll                                                       | —                         | 1.5–2   |          |
| 14  | D-02  | edit   | Diceroll: onboard through the wizard and Integration page      | ST-43, ST-41, LX-36       | 1–1.5   |          |
| 15  | D-03  | edit   | Diceroll                                                       | A-25, P2-08, P2-11        | 1–2     |          |
| 16  | D-04  | edit   | Diceroll                                                       | P4-34                     | 1.5–2   |          |
| 17  | D-05  | edit   | Diceroll                                                       | P4-33, LX-35              | 1–2     |          |

**Dependencies:** F-33 needs P0-17's window. F-34 registers its keys through ST-05a and does not
wait for ST-09. F-37 mints its own packages-only token through the account device-code flow, so it
does not wait for ST-34 and never writes an admin token into a package-manager file. F-36 needs
P2-08. P2-10 builds the product Access page once LX-36's editor exists. P2-11 needs A-20 (Track H).
P4-33 needs A-25's Action v2. P2-12 (one update resolver) runs in Track K. Owner decision 3 decides
SDK feed visibility; if the SDK feeds are gated, SP-38 (Track J) ships in the same release.

**Exit criteria:**

- One `pkeyp_` token installs every package an account may read across products; customers never
  see the system product's SDKs in listings; existing `pkeyr_` tokens keep working until expiry
  and new service tokens are `pkeyci_`.
- A declared package gets a Customers feed with no console step; feed access offers Public or
  Customers only and the Entitled migration gives no principal new access; Upstream and the dead
  feed knobs are gone.
- `-main.N` and dev builds are pruned at the next stable by default, after a dry-run notice, with
  no new setting.
- stable, beta and dev exist for every product; a release can be demoted (a per-track yank); one
  product Access page answers who gets what; the Updates page shows only shipped platforms'
  updaters with Wired status.
- Packs use `transports.packs: auto`; a gated pack needs one approval; D-02..D-05 pass on
  Diceroll.

---

## J. SDK and UI-kit consolidation

**Order 3.** **Goal:** one way in for developers (`polaris-key.json`, `fromConfig()` then
`boot()`), one name per concept recorded in `api.json`, one copy pipeline, and kit work done
once on the must tier. Lands before the next six-SDK waves (I-10a/b, LX-19, U-06, CM-15).

| #   | Id     | Origin | Title                                                                            | Depends on (open)                                                           | Weeks     | Flags        |
| --- | ------ | ------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- | ------------ |
| 1   | SP-35  | SDX-04 | SDK API registry (api.json) and 0.9 normalisation                                | P0-42, HA-13, HA-14                                                         | 2–3       | plan         |
| 2   | SP-34  | SDX-03 | client-core takes the neutral TypeScript                                         | P0-44, SP-35                                                                | 1.5–2     | plan         |
| 3   | SP-39  | SDX-08 | One copy pipeline                                                                | SP-34, P0-42, SP-32b                                                        | 0.8–1.2   |              |
| 4   | SP-40  | SDX-09 | Retire React cookie-mode browser sessions                                        | I-08, I-10a, SP-35                                                          | 0.4–0.6   |              |
| 5   | UK-02b | keep   | UI state fixtures and parity rows                                                | —                                                                           | 1–1.5     | plan         |
| 6   | UK-03  | edit   | ui-core: the one JS headless layer (absorbs UK-14's models)                      | UK-02b                                                                      | 2–3       |              |
| 7   | UK-04  | edit   | @polaris-key/elements on Lit 3                                                   | UK-03                                                                       | 3–4       |              |
| 8   | UK-05  | edit   | @polaris-key/react rebuilt on ui-core                                            | UK-03, UK-04                                                                | 3–4       |              |
| 9   | UK-07  | edit   | SwiftUI kit for iOS and iPadOS 26                                                | UK-02b                                                                      | 4–6       |              |
| 10  | UK-08  | edit   | SwiftUI kit for macOS 26                                                         | UK-07                                                                       | 2–3       |              |
| 11  | UK-09  | edit   | Compose Multiplatform kit for Android                                            | UK-02b                                                                      | 4–5       |              |
| 12  | UK-10  | keep   | Compose Multiplatform kit for JVM desktop                                        | UK-09                                                                       | 2–3       |              |
| 13  | UK-11  | edit   | Godot UI kit modernised in place                                                 | UK-02b                                                                      | 5–7       |              |
| 14  | UK-12  | edit   | Qt Quick kit on polaris_key.ui.core                                              | UK-02b                                                                      | 3–4       |              |
| 15  | SP-31  | edit   | Electron bridge v4: first slice of the Electron kit                              | —                                                                           | 0.75–1.25 |              |
| 16  | UK-06  | edit   | Electron kit inside @polaris-key/node/electron                                   | UK-03, UK-05, SP-31                                                         | 1.5–2     |              |
| 17  | UK-31  | edit   | UI-kit recipes: Vue, Svelte, Angular, Solid, htmx, Tauri, your own design system | UK-04                                                                       | 1–1.5     | now required |
| 18  | UK-41  | edit   | UI kits must-tier close-out (reduced matrix)                                     | UK-04, UK-05, UK-06, UK-07, UK-08, UK-09, UK-10, UK-11, UK-12, HA-13, HA-14 | 1–1.5     |              |
| 19  | UK-42  | edit   | Activation without an account in ui-core, the elements and React                 | UK-03, UK-05, I-10a                                                         | 0.8–1.2   |              |
| 20  | UK-43  | edit   | Activation without an account in the native kits                                 | UK-42, UK-07, UK-09, UK-11, UK-12, I-10b                                    | 1–1.5     |              |
| 21  | SP-15  | keep   | React local client and update lifecycle                                          | —                                                                           | 1–1.5     |              |
| 22  | HA-13  | keep   | SDKs and UI kits read presentation                                               | —                                                                           | 1–1.5     | plan         |
| 23  | HA-14  | keep   | Godot SDK and UI kit read presentation                                           | —                                                                           | 0.5–0.8   | plan         |
| 24  | HA-15  | edit   | Hosted assets close-out                                                          | —                                                                           | 0.4–0.6   |              |
| 25  | MO-13  | edit   | Motion QA closeout                                                               | —                                                                           | 0.3–0.5   |              |
| 26  | SP-38  | SDX-07 | Conditional: token provisioning for SDK installs                                 | SP-33b, F-37                                                                | 0.8–1.2   | optional     |

**Dependencies:** the SDK public-API lane is serial by dependency: SP-35 (names; HA-13 and HA-14
land first and are recorded) → SP-34 (client-core, owner decision 8) → SP-32a → SP-32b (Track C)
→ SP-39. SP-35 and SP-32a are client-API plan mode. UK-02b's plan is dispatched in week 0; UK-03
needs it. UK-06 builds on SP-31. UK-42 needs I-10a (Track K). SP-40 retires React cookie mode
after I-08 and I-10a (owner decision 7). Owner decision 6 sets the kit scope: if the answer is
no, the should-tier packages return after the consolidation waves, off the critical path. The
longest chain in the whole plan is here: UK-02b → UK-03 → UK-04 → UK-05 → UK-06 → UK-41 (about
16 weeks upper).

**Exit criteria:**

- Every SDK loads the same `polaris-key.json` fixture; every SDK's surface test asserts every
  canonical symbol in `api.json`; no SDK verb exists outside it.
- Node and React import the neutral modules from `client-core`; the plan-mode rule names only
  client-core's wire modules (if owner decision 8 is yes).
- The must-tier kits (elements, React, Electron inside `@polaris-key/node/electron`, SwiftUI iOS
  and macOS, Compose Android and Desktop, Godot, Qt Quick, two terminals) pass UK-41's close-out,
  including rendering SP-33b's goldens; UK-31's recipes build in CI.
- React cookie mode is removed from the SDK and the Worker in 0.9 (SP-40).

---

## K. Corpus lane (wire trains, serial)

**Order 3, runs throughout.** **Goal:** run every wire and contract-text event once, batched by
domain, additive inside v4 (`PROTOCOL_VERSION` stays 4, the corpus is appended), with SDK waves
on SP-35's names.

| #   | Id    | Origin | Title                                                                               | Depends on (open)                        | Weeks    | Flags                    |
| --- | ----- | ------ | ----------------------------------------------------------------------------------- | ---------------------------------------- | -------- | ------------------------ |
| 1   | I-27  | IX-00  | Plan the identity consolidation                                                     | —                                        | 0.8–1.2  | plan                     |
| 2   | I-08  | edit   | App passthrough on an OAuth-shaped authorize and token (absorbs PX-W18)             | I-09, I-27, P0-20                        | 1.2–1.7  | plan                     |
| 3   | I-09  | edit   | license_owned refusal, attach and sign-out (consolidated spec)                      | I-27                                     | 0.8–1.1  | plan                     |
| 4   | I-10a | edit   | SDK identity v2 and key-entry outcome: Node, React, Python (absorbs PX-W9b, UK-44)  | I-08, I-09, SP-35                        | 1–1.4    | plan                     |
| 5   | I-10b | edit   | SDK identity v2 and key-entry outcome: Swift, Kotlin, Godot (absorbs PX-W9b, UK-44) | I-08, I-09, SP-35                        | 1.4–1.95 | plan                     |
| 6   | P2-12 | UC-05  | One update resolver: retire the GitHub-resolved appcast and version path            | P0-26                                    | 1–1.5    | plan                     |
| 7   | CM-20 | new    | Commerce consolidation plan (= LX-11's plan)                                        | —                                        | 0.6–0.9  | plan                     |
| 8   | LX-18 | edit   | W-LX: the licensing and store-commerce wire train                                   | LX-09, LX-12, LX-41, LX-35, CM-20, P0-44 | 0.6–0.85 | plan                     |
| 9   | LX-42 | new    | Quantities and consumables (required licensing-train member)                        | LX-35, LX-18                             | 1–1.4    | plan, sec                |
| 10  | P2-14 | UC-08  | Optional: split the dev channel from the dev-build bypass                           | P2-08, LX-18                             | 0.6–0.9  | plan, optional           |
| 11  | LX-19 | edit   | Six SDKs on the licensing wire (one wave with LX-20)                                | LX-18, SP-35, UK-03                      | 1.6–2.25 | plan                     |
| 12  | LX-20 | edit   | Store commerce client parity (one wave with LX-19)                                  | LX-11, LX-18, SP-35                      | 1–1.4    |                          |
| 13  | LX-25 | edit   | Redeem codes targeting a tier or add-on (optional train member)                     | LX-11, LX-35, P0-20                      | 0.5–0.7  | plan, optional           |
| 14  | CM-14 | edit   | Device checkout hand-off: W1 and W3 (deferred)                                      | CM-01, CM-05, LX-20                      | 0.6–0.9  | plan, deferred, optional |
| 15  | CM-15 | edit   | Checkout hand-off and manageBilling() in the SDKs (deferred)                        | CM-14, LX-19                             | 1.4–2    | deferred, optional       |

**Trains, in order** (each holds the lane only while it changes the corpus, rule 3):

1. **P0-44**, the corpus generator split (Track B), right after HA-12 (done).
2. **W-ID:** I-27 (plan) → I-09 → I-08 (OAuth-shaped, absorbs PX-W18; it depends on I-09) →
   I-10a and I-10b (absorb PX-W9b and UK-44). No signed shape changes; `redirect-web-*`
   transcripts re-recorded. Tail: **LX-39** (Track E) changes WIRE-CONTRACT-V4 §12.2's text and
   the `keyentry-refusals-off` transcript once I-10a/b exist.
3. **W-SYNC:** U-01b's appended `sync-scenarios.json` rows, then U-05's `sync-*` transcripts
   (Track G).
4. **W-LX:** its prerequisites (LX-41, LX-35, CM-20) go ahead of everything else queued; then
   LX-18 with required members: the duration member `term` (onExpiry stop, keepVersion or a trial's
   `tier:<id>`), add-on grants, the consumable rows that LX-42 implements, refusal reasons,
   `offers[]`, the `app` claim kind, `transferred`, W4; optional appended members only if ready:
   LX-25, P2-14 → LX-19 and LX-20 as one SDK wave (consume and acknowledge verbs included).
5. **W-UP:** P2-12, one update resolver; transcripts byte-identical, so it changes no corpus file
   and holds the lane only for its golden check at merge; it interleaves.
6. **Owner decision 5 "go":** CM-14 (W1, W3) and CM-15 for Polaris Key checkout.

The channels predicate never changes: "dev includes beta" is applied at write time by the
editors (LX-33, P2-08), and grants are matched as stored (WIRE-CONTRACT-V4 §5.1 rule 4).

**Dependencies:** every row is plan mode except the SDK waves that execute an approved plan.
Each plan names its corpus regeneration and every SDK that follows. SP-35 must land before
I-10a/b and LX-19.

**With the lanes modelled** (upper estimates, unlimited builders, week 0 = batch 6 on main;
plan approvals and owner steps not modelled): P0-44 ends at week 2; I-09 at 3.1; I-08 at 5.2;
I-10b at 7.2; LX-39 at 7.8; LX-18 at 10.0; LX-19 and LX-20 at 12.3 and 12.7; CM-23 at 14.5; the
whole plan at 16.0 (the kit chain). The lane is not the bottleneck once SDK waves stop holding it;
the licensing chain through P0-49 and LX-33 is.

**Exit criteria:**

- `PROTOCOL_VERSION` is still 4; every corpus change is appended; every train's transcripts
  replay in all six SDKs.
- Avoided on purpose: a `commerce` service slug, removing `flag` rows from `/config/schema`,
  SP-10's W10 document, I-24a's members, new outlet kinds, a changed channels predicate, and an
  SDK-reported verification flag.

---

## Parked packages (40)

Parked packages are `optional` and deferred, so `--ready` and `--critical` skip them. Each brief
gets "parked 2026-10-07" and its revive condition; re-read the brief against the code before
reviving it.

| Id    | Title                                                                            | Revive when                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6-04 | Optional                                                                         | Hosted channel-pinned web builds. Revive when the DNS block clears and a product ships web builds; it then serves dev and beta too (P2-08).                                                                            |
| I-23  | App-specific profiles per account × product, with consent and per-product …      | App-specific profiles duplicate Cloud Sync account x product data. Partial sharing is I-34's granular consent. Revive only if a product needs per-app profile fields that a Cloud Sync record cannot hold.             |
| I-24a | Named-user seats, server half                                                    | Named-user seats: not an owner ask and would add licensing-train members (C-45). Revive when a product asks; its wire rows then join the next licensing train.                                                         |
| I-24b | Named-user seats in the SDKs                                                     | Parked with I-24a; kit screens would render in the rebuilt kits only.                                                                                                                                                  |
| I-25  | RFC 7523 product-backend assertion (console platforms) with jti replay cache …   | Console-platform backend assertion. Revive when a console storefront (PSN, Xbox, Nintendo) becomes real.                                                                                                               |
| U-14  | Live pokes over hibernating WebSockets in all six SDKs (Godot WebSocketPeer)     | Live pokes. Pull on foreground, online and visibility covers 'restore from any instance'. Revive after launch if sync latency is a measured complaint.                                                                 |
| U-16  | Developer-backend Cloud Sync API for ownerRead and server collections, …         | Developer-backend API for ownerRead/server collections; none at launch. Revive with the first server-authoritative collection and I-21.                                                                                |
| X-01  | Optional                                                                         | C# SDK (10-14 weeks). Revive only with a committed adopter; then F-32 and an SP-33b golden column ship in the same package.                                                                                            |
| F-32  | Optional                                                                         | NuGet v3 feed. Revive when X-01 goes ahead or a product declares a `nuget` package deliverable; it inherits F-33 and F-34 when revived. WinGet is a distribution channel (A-19), not a feed.                           |
| ST-18 | Promote to repo (patch), settings export and import, pkey settings diff and …    | Promote-to-repo, export/import and settings diff have little value on a two-product deployment (C-46). Revive with a third-party adopter, on P0-45's command registry and personal tokens.                             |
| ST-23 | Environment export, diff and promote                                             | Environment export/diff/promote and copy-from-product (C-46). Copy-from-product returns as a New Product wizard step when a third product exists.                                                                      |
| LX-24 | Per-seat feature assignment, with I-24's named-user seats                        | Per-seat features with named-user seats; no owner ask. Revive with I-24a.                                                                                                                                              |
| SP-10 | Signed browser-session document for React cookie mode, kept for first-party …    | Owner decision 7: retire cookie mode (SP-40) for bearer mode plus I-08's web redirect, avoiding a signed W10 document. Revive only if a first-party app needs cookies; it would run as a fourth wire train after W-LX. |
| SP-28 | Steam depot pack transport for desktop SDKs (packs.transport.steam)              | Steam depot transport for non-Godot desktop SDKs. Revive when such a product ships; P4-33's auto then picks it.                                                                                                        |
| SP-29 | MSIX optional-package and Flatpak extension pack transports …                    | MSIX and Flatpak pack transports. Revive when a product declares msix-optional or flatpak-ext.                                                                                                                         |
| SP-30 | Godot MSIX optional-package and Flatpak extension pack transports …              | Godot side of SP-29.                                                                                                                                                                                                   |
| HA-16 | Optional                                                                         | Release-note images. Revive after A-27 if notes need hosted images; What's New formatting shipped in ST-36.                                                                                                            |
| HA-17 | Optional                                                                         | Store video slots. Revive as a listing slot when a channel requires one (Steam trailer).                                                                                                                               |
| UK-17 | @polaris-key/vue                                                                 | Vue kit package. Vue ships as a UK-31 recipe over the elements; revive as a package when an adopter ships on Vue.                                                                                                      |
| UK-18 | @polaris-key/svelte                                                              | Svelte kit package; a UK-31 recipe until an adopter ships on Svelte.                                                                                                                                                   |
| UK-19 | @polaris-key/angular                                                             | Angular kit package; a UK-31 recipe until an adopter ships on Angular.                                                                                                                                                 |
| UK-20 | @polaris-key/react-native                                                        | React Native (4-6 weeks, a native module over two SDKs). Revive when a product ships React Native.                                                                                                                     |
| UK-21 | Tauri v2 bridge                                                                  | Tauri bridge package (absorbs X-02). Tauri ships as a UK-31 recipe; revive when the recipe proves insufficient for an adopter.                                                                                         |
| UK-23 | PolarisKeyUIKit                                                                  | PolarisKeyUIKit package; the UIKit hosting recipe ships in UK-07.                                                                                                                                                      |
| UK-24 | PolarisKeyAppKit                                                                 | PolarisKeyAppKit package; the AppKit recipe and Sparkle bridge ship in UK-08.                                                                                                                                          |
| UK-25 | StoreKit 2 Paywall                                                               | StoreKit 2 Paywall. Revive into UK-07 when LX-23 lands (a SubscriptionStoreView needs a server side); maps products through offers().                                                                                  |
| UK-26 | visionOS kit                                                                     | visionOS kit. Revive when a product targets visionOS.                                                                                                                                                                  |
| UK-27 | tvOS kit                                                                         | tvOS kit. Revive if Diceroll or another product targets Apple TV; TV sign-in already works through device code in the SDKs and the iOS kit.                                                                            |
| UK-28 | Android Views interop                                                            | Android Views package; the Views recipe ships in UK-09.                                                                                                                                                                |
| UK-29 | Godot .NET (C#) facade                                                           | Godot .NET facade. Revive with X-01.                                                                                                                                                                                   |
| UK-32 | Optional                                                                         | Ink components duplicate UK-14's terminal kit.                                                                                                                                                                         |
| UK-33 | Optional                                                                         | watchOS. Revive when a product targets watchOS.                                                                                                                                                                        |
| UK-34 | Optional                                                                         | WidgetKit, Live Activities and App Intents. Revive with a product ask.                                                                                                                                                 |
| UK-35 | Optional                                                                         | Android TV, Glance and notifications. Revive with a product ask; device-code sign-in covers Android TV meanwhile.                                                                                                      |
| UK-38 | Optional                                                                         | wxPython and Kivy adapters; ui-core lets a host draw its own.                                                                                                                                                          |
| UK-39 | Optional                                                                         | Python web UIs (NiceGUI, Gradio, Flet); the elements already embed.                                                                                                                                                    |
| PS-08 | Optional                                                                         | product_idp obtain path. Revive after I-32 (product connections) if a product with its own IdP wants Discover.                                                                                                         |
| CM-10 | Gifting                                                                          | Gifting; needs optional LX-25. Revive after reduced checkout v1.                                                                                                                                                       |
| CM-18 | Regional store link-out programmes (US App Store external purchase links, Play … | Regional store link-out programmes (owner G6). Revive with a regional programme decision.                                                                                                                              |
| CM-19 | Own-account mode                                                                 | Own-account mode with Stripe as merchant of record (owner G5). Revive after v1 if asked.                                                                                                                               |

**Parked ideas without a graph id** (each recorded in `uxRows` or here so nothing is lost):

| Idea                                                                                  | Revive when                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| UC-06 rollout plans with auto-advance                                                 | A product asks for staged auto-promotion; with a security review.                                       |
| CFG-08 SDKs reading minted tokens by catalog key                                      | After U-31, if adopters ask.                                                                            |
| Product editor and Product viewer roles                                               | A product needs read-only or edit-only members that an area-narrowed Product admin cannot express.      |
| Platform-wide service restriction (owner brief "restrict features ... platform-wide") | A deployment needs a service off for every product; one platform policy row in ST-16.                   |
| Age booleans and `minimumAge` (I-33 keeps only the optional birth date)               | A product gates content by age.                                                                         |
| UX-06b entity search                                                                  | ST-10's settings search and the product switcher stop being enough (a third product or a support desk). |
| UX-08b devices on this version                                                        | Operators ask for per-version device counts on A-22's Releases tab.                                     |
| UX-25 person drawer                                                                   | After UX-06b.                                                                                           |
| UX-27 server activity search                                                          | A product's activity outgrows client-side filtering.                                                    |
| UX-36 bulk licence actions                                                            | The first bulk request (P0-29's paging is its base).                                                    |
| UX-49 portal on the shared kit                                                        | A portal page needs a component P0-37's inventory lacks.                                                |

## Crosswalk: integration.md ids to registered ids

| integration.md | Registered id | Title                                                                                   |
| -------------- | ------------- | --------------------------------------------------------------------------------------- |
| CQW-01         | P0-15         | Platform primitives and duplicate-helper sweep                                          |
| CQW-02         | P0-16         | First-party respond and body module for console and portal                              |
| CQW-03         | P0-17         | Layering move (lead codemod at the batch-6 boundary)                                    |
| CQW-04         | P0-18         | Table ownership, owner stores and one audit writer (absorbs ST-24)                      |
| CQW-05         | P0-19         | Descriptor contributions and services/<slug>/api.ts facades                             |
| CQW-06         | P0-20         | Split identity/oidc.ts; extract the issuance engine to core/licensing                   |
| CQW-07         | P0-21         | Notification substrate (core/notify)                                                    |
| CQW-08         | P0-22         | Request-scoped product context, lazy signer, one hosts table                            |
| CQW-09         | P0-23         | Portal off Release's tables                                                             |
| CQW-10         | P0-24         | Migration ledger and one-time machinery sunset                                          |
| CQW-17         | P0-49         | Data-migration runner (dry run, report, apply)                                          |
| CQW-11         | P0-25         | Service, portal and public route tables                                                 |
| CQW-12         | P0-26         | Core manifest ingest pipeline                                                           |
| CQW-13         | P0-27         | One adapter per store (delivery and commerce facets)                                    |
| CQW-14         | P0-28         | One sealed credential store and resolver                                                |
| CQW-14b        | P0-28b        | Drop the old credential stores (release N+1)                                            |
| CQW-15         | P0-29         | Licence list paging and set queries                                                     |
| CQW-16         | P0-30         | Guardrails, test harness and test layout                                                |
| CQF-01         | P0-31         | Console shared-layer cleanup (lead window)                                              |
| CQF-02         | P0-32         | One data layer for console and portal                                                   |
| CQF-03         | P0-33         | Worker-owned DTO types for the admin and portal APIs                                    |
| CQF-04         | P0-34         | Shared hash-router core                                                                 |
| CQF-05         | P0-35         | Vocabularies as data (platforms, ecosystems, licence)                                   |
| CQF-06         | P0-36         | Portal on the copy catalog                                                              |
| CQF-07         | P0-37         | Complete the shared component inventory                                                 |
| CQF-08         | P0-38         | AuthCard in ui/auth (UX-40)                                                             |
| CQF-10         | P0-39         | Console sections move and page budget (lead window)                                     |
| CQF-11         | P0-40         | Console and portal tests and oxlint                                                     |
| CQF-13         | P0-41         | Living ADMIN.md and PORTAL.md; UX rows registered                                       |
| CQT-01         | P0-42         | Generator registry and pnpm gen                                                         |
| CQT-02         | P0-43         | CI consolidation                                                                        |
| CQT-03         | P0-44         | Corpus generator split (corpus lane, right after HA-12)                                 |
| CQT-04         | P0-45         | pkey command registry, context and doctor                                               |
| CQT-05         | P0-46         | Lint baselines with debt ledgers                                                        |
| ST-05 (split)  | ST-05a        | One settings read and write path                                                        |
| ST-05 (split)  | ST-05b        | Generic settings routes with bespoke routes as adapters                                 |
| AC-01          | ST-28         | Plan: console RBAC and console identity on accounts                                     |
| AC-02          | ST-29         | Admin route table, can(), useCan and NoAccessPage (absorbs ST-21)                       |
| AC-03          | ST-30         | Console sign-in on Polaris Key accounts                                                 |
| AC-04          | ST-31         | Roles, bindings, invites and the Members pages (absorbs ST-22)                          |
| AC-05          | ST-32         | SSO rules and the adminGroup conversion                                                 |
| AC-07          | ST-34         | Admin-scope personal tokens and pkey login                                              |
| AC-08          | ST-35         | RBAC docs, lockout recovery, docs-gate split and adminGroup contract                    |
| OB-00          | ST-36         | Owner polish: portal fixes and the simple product card (fix/ux-polish-1007)             |
| OB-01          | ST-37         | Vocabulary: one word per concept (rule 4)                                               |
| OB-02          | ST-38         | Service table: five features; one service-off state (absorbs DC-12)                     |
| OB-03          | ST-39         | Wizard kit                                                                              |
| OB-04          | ST-40         | Integration facts and SDK sightings                                                     |
| OB-05          | ST-41         | Integration page and Overview card                                                      |
| OB-06          | ST-42         | Create with defaults                                                                    |
| OB-07          | ST-43         | New Product wizard                                                                      |
| OB-08          | ST-44         | One Home; delete GET /manage/api/summary; slim product list                             |
| OB-09          | ST-45         | Platform and Product sidebar contexts                                                   |
| OB-10          | ST-46         | Interactive pkey init                                                                   |
| OB-11          | ST-47         | Legacy setup retirement                                                                 |
| IX-00          | I-27          | Plan the identity consolidation                                                         |
| IX-01          | I-28          | Accounts contract phase                                                                 |
| IX-01b         | I-28b         | Accounts contract drops (release N+1)                                                   |
| IX-02          | I-29          | Retire per-product account toggles; one App sign-in page                                |
| IX-03          | I-30          | Connections: one OIDC relying-party client, verified domains, identifier routing        |
| IX-04          | I-31          | Platform -> Connections and setup wizards                                               |
| IX-05          | I-32          | Product connections (absorbs I-22)                                                      |
| IX-08          | I-33          | Profile v2: screen name, birth date, platform terms                                     |
| IX-09          | I-34          | Granular consent and Connected apps                                                     |
| IX-10          | I-35          | One identity: manifest block (joint with LX-36)                                         |
| IX-11          | I-36          | Sign-in Integration card                                                                |
| CFG-01         | U-27          | Keep the licence config layer; delete the override-migration machinery                  |
| CFG-01b        | U-27b         | Drop the override-migration tables (release N+1)                                        |
| CFG-02         | U-28          | One config chain: Default profile, one profile per tier, no device layer                |
| CFG-03         | U-29          | Effective config with provenance                                                        |
| CFG-04         | U-30          | Config types and in-app visibility in one vocabulary                                    |
| CFG-05         | U-31          | Minted tokens carry their recipe                                                        |
| CFG-07         | U-32          | Catalog templates, Cloud Sync page, minted-token wizard and the Integration config card |
| FX-01          | F-33          | Personal tokens (pkeyp\_, packages:read) and portal Packages                            |
| FX-02          | F-34          | Feeds that provision themselves, Customers by default                                   |
| FX-03          | F-35          | Publish to public registries (absorbs DC-13)                                            |
| FX-04          | F-36          | Feed cleanup on by default (dev and main prereleases)                                   |
| FX-05          | F-37          | pkey feeds setup --write and CLI naming                                                 |
| UC-01          | P2-08         | Built-in dev release track and default store track maps                                 |
| UC-02          | P2-09         | Demote a release down a release track                                                   |
| UC-03          | P2-10         | Product Access page: who gets what (absorbs LX-37)                                      |
| UC-04          | P2-11         | Updates page: updaters for shipped platforms with Wired status                          |
| UC-05          | P2-12         | One update resolver: retire the GitHub-resolved appcast and version path                |
| UC-07          | P2-13         | Portal channel picker and SHA-256                                                       |
| UC-08          | P2-14         | Optional: split the dev channel from the dev-build bypass                               |
| CP-01          | P4-33         | Pack transports auto                                                                    |
| CP-02          | P4-34         | One-click pack gate and the packs-without-Update warning                                |
| DC-02          | A-19          | One channel catalogue (tools/channels.json)                                             |
| DC-03          | A-20          | Product facts and the channel read model                                                |
| DC-04          | A-21          | Console IA: Distribution and Commerce groups                                            |
| DC-05          | A-22          | The channel page (Status, Releases, Listing, Sales, Setup)                              |
| DC-06          | A-23          | Channel setup: wizards and the setup runner                                             |
| DC-06b         | A-33          | Channels enable in one confirmation; a storefront activates with its channel            |
| DC-07          | A-24          | Publish everywhere and the verb facade                                                  |
| DC-08          | A-25          | Action v2: channels auto and thin inputs (absorbs CQS-10)                               |
| DC-09          | A-26          | Customer channel actions                                                                |
| DC-10          | A-27          | One listing truth (absorbs ST-13)                                                       |
| DC-10b         | A-27b         | Drop the dist_listing table (release N+1)                                               |
| DC-11          | A-28          | One store-app binding with derived identity                                             |
| DC-14          | A-29          | Homebrew formula for CLI archives                                                       |
| DC-15          | A-30          | Generated SHA256SUMS                                                                    |
| DC-16          | A-31          | Derived identities and a short .pkey/distribution                                       |
| DC-17          | A-32          | GitHub write path and Publish from CI                                                   |
| SDX-01         | SP-32a        | polaris-key.json: plan, schema, fromConfig() and doctor() in Node, React and Python     |
| SDX-01b        | SP-32b        | polaris-key.json, fromConfig() and doctor() in Swift, Kotlin and Godot                  |
| SDX-02         | SP-33a        | One integration content generator on today's names, and pkey sdk add --expect           |
| SDX-02b        | SP-33b        | Integration content on polaris-key.json in every SDK, the docs and the Godot dock       |
| SDX-03         | SP-34         | client-core takes the neutral TypeScript                                                |
| SDX-04         | SP-35         | SDK API registry (api.json) and 0.9 normalisation                                       |
| SDX-05         | SP-36         | Examples in one tree, built in CI                                                       |
| SDX-06         | SP-37         | Developer docs reshape                                                                  |
| SDX-07         | SP-38         | Conditional: token provisioning for SDK installs                                        |
| SDX-08         | SP-39         | One copy pipeline                                                                       |
| SDX-09         | SP-40         | Retire React cookie-mode browser sessions                                               |

The quick-win bundles P0-47 and P0-48 have no integration id; they hold Track A's quick wins.
Not built: AC-06 (ST-33, requests; NoAccessPage lists the admins instead). Folded: LX-37 (License
→ Access page) into P2-10's product Access page.
