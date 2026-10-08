# ST-19b Manifest-declared settings into the registry: the release GitHub block, binary name, channel workflow, beta branch, summary marker, manual channels, deliverables, trusted publisher, channel policy, release keys, compat window, registration, secret names, provisioning and transports; their `PENDING` entries removed

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| Phase       | ST: Settings, access control and console shell (phase 4: manifest round trip)               |
| Size        | 0.4–0.6 engineer-weeks                                                                      |
| Depends on  | [ST-19](ST-19-manifest-cleanup.md)                                                          |
| Unblocks    | [ST-25](ST-25-legacy-retirement.md)                                                         |
| Role        | `pkey-implementer`                                                                          |
| Plan mode   | no                                                                                          |
| Gates       | rule 6 (boundaries); `gen:settings --check` (drift gate); generated docs reference (rule 3) |
| Human input | none                                                                                        |
| Repo        | `vladzaharia/polaris-key`                                                                   |

## Goal

Every manifest-declared field and table that ST-06's coverage test parked under ST-19 has a
registry entry, and the 21 `PENDING` entries that ST-19 hands to ST-19b are gone.

## Why

ST-06 gave ST-19 every manifest-declared field or table with no registry entry. The approved
[ST-19 plan](../plans/ST-19.md) (owner decision Q1, 2026-10-06) split them in two. The duplicate
spellings stay in ST-19. The real settings come here, because registering them (readers, docs,
capability, ownership, storage) needs no plan mode and does not fit ST-19's size. ST-25 closes the
`PENDING` list and needs this package first.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [`plans/ST-19.md`](../plans/ST-19.md): owner decisions, §3.5 (canonical registry paths and the
  wrapped coverage ids). Every path you register is a canonical spelling: the registry test
  refuses a deprecated one.
- [S-18 §4.2](../../notes/S-18-settings-architecture.md#42-the-registry) (entry fields and rules),
  [§4.13 item 2](../../notes/S-18-settings-architecture.md#413-drift-gates-keeping-configure-everything-true)
  (coverage), Appendix A.2 (seed list).
- [ST-06's brief](ST-06-settings-docs-coverage.md), "PENDING owners" and "What declares a target".
- An existing slice: `packages/worker/src/services/release/settings.ts`.

## Scope

**In:** registry entries for these `PENDING` targets, which ST-19 left owned by ST-19b. The ids
are the wrapped ids ST-19 introduces.

| Target(s)                                                                                   | Entry (suggested key)                           | Slice                               |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| `manifest:release:release.provider`                                                         | `release.github`                                | `services/release/settings.ts`      |
| `manifest:release:release.binaryName`                                                       | `release.binaryName`                            | release                             |
| `manifest:release:release.channelWorkflow`, `…betaBranch`                                   | `release.channelWorkflow`, `release.betaBranch` | release                             |
| `manifest:release:release.summaryMarker`                                                    | `release.summaryMarker`                         | release                             |
| `manifest:release:release.manualChannels`                                                   | `release.manualChannels`                        | release                             |
| `manifest:release:release.deliverables`, `column:release_deliverables.def_source`           | `release.deliverables`                          | release                             |
| `manifest:release:release.publishing`, `table:ci_publishers`, `column:ci_publishers.source` | `release.publishing.trustedPublisher`           | release                             |
| `table:release_channel_policy`, `column:release_channel_policy.source`                      | `release.channelPolicy`                         | release                             |
| `manifest:release:release.releaseKeys`                                                      | `release.keys`                                  | release                             |
| `manifest:product:product.compatMax`                                                        | the existing `release.compatWindow`             | release                             |
| `manifest:product:devices`                                                                  | `core.registration`                             | `core/settings/core.ts`             |
| `manifest:product:secrets`                                                                  | `core.secrets` (names only)                     | core                                |
| `manifest:product:provisioning`, `table:provisioning_config`                                | `identity.provisioning`                         | `services/identity/settings.ts`     |
| `manifest:distribution:transports`, `table:dist_transports`                                 | `distribution.transports`                       | `services/distribution/settings.ts` |

Remove each target from `PENDING` in the change that registers it, and lower `PENDING_CEILING` by
the same count (21 in total).

**Out** (and where it belongs instead):

- Spelling deprecations, canonical paths of existing entries and the parity test (→ ST-19).
- New console editors for these settings. Each entry gets the generic row ST-07/ST-08 render;
  bespoke editors stay where they are.
- Moving storage. Entries describe today's columns and tables; no migration.

## Design notes

- **Ownership.** Everything here is `manifest` (read-only in the console, "edit `.pkey/…`")
  except where the code already lets the console write it today; check each reader and say so in
  the entry. `core.secrets` is `sensitivity: "secret"` with names only; `release.keys` carries
  public keys only.
- **Storage.** `column` where one column holds the value (`release_config.*`), `rich` with an
  adapter name for the per-row tables (`ci_publishers`, `release_channel_policy`,
  `release_deliverables`, `provisioning_config`, `dist_transports`). A rich adapter declares its
  table and that table's row-level `source` marker, which is how the column targets above get a
  home.
- **`compatMax`.** `release.compatWindow` already covers both bounds but has one
  `manifest.path` (`product:product.compatMin` after ST-19). Pick the smallest change that lets one
  entry declare both fields, for example an optional `manifest.alsoPaths` read by
  `scripts/settings-coverage.ts` and by the registry rules, and record the choice in the entry
  comment.
- **Readers** must be real files (the registry test checks them). Docs links must resolve to
  existing pages; add a short section to the owning service page where none fits.
- **Wire.** None of these entries changes a signed document or discovery; set `wire` only where
  the value already reaches discovery or a document today.

### Corrections from the build (the code is the fact)

- **`core.secrets` is pending on ST-08.** Nothing in the Worker reads `secrets.required`: the
  validator collects it for `pkey validate`, and the console's setup check (`admin/lib/shape.ts`)
  derives the required names from `oidc` and `edgeMint`. The values live in `product_secrets`,
  whose `PENDING` entry belongs to ST-08. The entry is registered with `pending: { wp: "ST-08" }`,
  no readers and `storage: { kind: "none" }`. ST-08 extends it with the `product_secrets` adapter
  and its readers, and does not register it again (its brief says so).
- **`release.github` is stored from the link, not from the manifest.** `gh_owner`, `gh_repo` and
  `gh_installation_id` come from the repository linked under Settings → Repository (a refused
  link-existing restores the previous ones), and a resync never writes them. There is no Unlink
  action in the code. The manifest's `provider` is validated, and it is
  compared with the platform repository only for the system product (`systemManifestProblem`).
  The entry is `manifest`-owned, because the console has no settings write for it besides Link. It is security-widening (whose releases are served, who can publish). Storage names
  `gh_owner`, because `storage` holds one column.
- **Claimable, from the code:** `core.registration` (the Services page's PATCH claims
  `services_json`), `release.channelPolicy` (console and CI operations claim the row) and
  `release.publishing.trustedPublisher` (the console's `PUT …/ci-publisher` claims it; there is no
  revert route yet). Everything else is `manifest`.
- **`wire`** is set where a value already reaches a device:
  - discovery: `core.registration` (with the `registration_closed` refusal), `release.github`
    (Release's `repository`), `release.binaryName`, `release.manualChannels` (Update's
    `channels`) and, on the existing entry, `release.sparkleEd25519Pub` (Update's
    `sparkleEd25519PublicKey`);
  - the signed feed: `release.manualChannels` (a manual channel's name is the feed's `channel`
    claim), `release.deliverables`, `release.channelPolicy` and `distribution.transports` (pack
    sets, floors and pins);
  - the licence document: `identity.provisioning` (the entitlement a hook writes).
- **`SECURITY_WIDENING_KEYS`** (`rules.ts`) now lists the five widening entries this package adds,
  and the existing `cloudSync.writes`.
- **Docs links are page paths, with no anchors.** The console's help-link gate
  (`test/docsLinks.test.ts`) checks the settings search index against the built slug manifest. The
  release block's fields link to the new "The release block" section's page, GitHub sync.
- **`compatMax`** uses `manifest.alsoPaths`, which is checked by `rules.ts`, the registry test
  and `settings-coverage.ts`, and is listed in the generated reference.

## Steps

1. Release slice entries (the bulk).
2. Core, identity and distribution entries.
3. `compatMax` on `release.compatWindow`.
4. Remove the 21 `PENDING` entries and lower the ceiling; regenerate the settings reference.

## Acceptance criteria

- [x] No `PENDING` entry is owned by ST-19 or ST-19b.
- [x] `settings-registry.test.ts` and `settings-coverage.test.ts` pass; every new path is canonical.
- [x] `reference/settings.mdx` and the console search index are regenerated, not edited.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate listed in the header.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test settings
mise exec node@22 -- pnpm gen:settings -- --check
mise exec node@22 -- pnpm --filter @polaris-key/docs check:links
```

## Hand-off

- ST-25 closes the `PENDING` list with what is left.

The role agent sets `--set ST-19b in-review` when it hands off. After review, the lead adds the
last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set ST-19b done`.
