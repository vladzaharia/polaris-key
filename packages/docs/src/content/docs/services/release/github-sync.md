---
sidebar:
  order: 2
title: "GitHub sync"
description: "Linking a repository, the GitHub App installation, the .pkey/ manifest, the push-webhook resync pipeline, and release-event store refreshes."
---

A Release-enabled product is never configured by filling in a form. It is configured by a
`.pkey/` manifest committed to a GitHub repository, and Polaris Key's job is to read that
manifest through a scoped GitHub App installation, apply it atomically, and keep applying
it every time the manifest changes. This page covers that whole pipeline: linking a repo
for the first time, what the manifest contains, how installation tokens are minted and
scoped, and the webhook that keeps a linked product current without anyone opening the
console: `push` events for the manifest, `release` events for the release truth store.

## Linking a repository

An operator pastes a repository URL into the console — `https://github.com/<owner>/<repo>`,
an SSH remote, or a bare `<owner>/<repo>` all parse the same way. From there:

1. Polaris Key asks GitHub which App installation covers that repository
   (`GET /repos/<owner>/<repo>/installation`, authenticated as the App itself with a
   short-lived JWT). If the App isn't installed there, linking fails with an actionable
   message rather than a generic error.
2. It mints an installation token scoped to that repository alone (more on scoping below).
3. It reads `schema`, `product`, and `release` out of the repo's `.pkey/` directory and
   parses them as a manifest.
4. For a brand-new product, it generates and seals a per-product Ed25519 signing key, then
   inserts the product row, the catalog, the signing key, the release configuration, and
   every other manifest-declared row (tiers, profiles, OIDC, provisioning, edge-mint) in
   **one atomic batch** — a partial product can never exist.
5. It seeds the release truth store from the repo's current releases, best-effort: a repo
   with nothing published yet is the normal case at link time, and a stalled GitHub read
   must not fail the link.

Linking a repository that is already a Polaris Key product resyncs it instead of creating a
duplicate — see [Resyncing](#what-a-resync-touches) below.

## The `.pkey/` manifest

Everything Release (and every other service) learns from a repo lives in exactly one
directory: `.pkey/`. Three documents, each independently JSON, YAML, or YML — Polaris Key
tries `.json` first, then `.yaml`, then `.yml`, per document, so a repo may mix formats
freely:

| Document          | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `.pkey/schema.*`  | the config catalog                                                        |
| `.pkey/product.*` | product metadata, enabled services, registration policy, OIDC, tiers      |
| `.pkey/release.*` | GitHub releases: binary name, channel workflow, Sparkle key, access modes |

There is no fallback directory and no dual-read of an alternate location — one directory,
tried in one fixed extension order, is the whole lookup.

Every field that ends up interpolated somewhere sensitive is bounded at this ingest
boundary, before it is ever stored: a binary name must match a strict filename-safe
character class (it is later interpolated into a shell script), a channel workflow
reference must look like a workflow file or numeric id, and so on. A manifest that fails
validation is rejected in full — nothing partial is ever applied.

## Installation tokens

Polaris Key authenticates to GitHub as its App, not as a person. An App JWT (signed RS256,
nine-minute lifetime) is exchanged for an **installation access token**, and that exchange
is where the scoping happens: the request names the exact repository and a read-only
permission set (`contents: read`, `metadata: read`, plus `actions: read` and
`pull_requests: read` only when the product configures a channel workflow), so the token
GitHub hands back is valid for that one repository and nothing else — even when the App
itself is installed org-wide. Tokens are cached, sealed, in KV for about 55 minutes (they
live roughly 60) so the common path is one KV read rather than two GitHub round trips per
request.

Every GitHub call in Release goes through this token — reading the manifest, listing
releases, resolving channel workflow runs, and streaming an artifact's bytes all use the
same short-lived, repository-scoped credential. Nothing longer-lived than that ever leaves
GitHub.

## The push-webhook resync pipeline

Once a repository is linked, `POST /webhooks/github` is what keeps it current. GitHub
signs every delivery (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body); a delivery
that doesn't verify is refused before anything else runs. Every delivery also carries a
GUID (`X-GitHub-Delivery`); Polaris Key remembers processed GUIDs for seven days and
short-circuits a repeat with an "ignored" response rather than reapplying it — a captured
delivery is otherwise a replay primitive, since a resync deletes and re-inserts several
manifest-owned tables and re-posting an old one could roll back an operator's own live
edit.

From there the pipeline narrows the delivery down before it does any real work:

- **Branch pushes only.** A push to anything other than `refs/heads/*` (a tag, for
  instance) is ignored — `.pkey/` is only ever read from a branch.
- **Manifest-relevant paths only.** The delivery's added/modified/removed file lists are
  checked against `.pkey/` itself and everything under it. A push that never touched the
  manifest directory is acknowledged and otherwise ignored — most pushes to most repos are
  exactly this.
- **The right installation.** The delivery names an installation id, and it must match the
  id recorded when the repository was linked. One webhook secret covers every installation
  on the platform, so without this check a single secret compromise would let an attacker
  forge a delivery for _any_ linked product, not just the repository they control.

A delivery that clears all three triggers a resync for every product linked to that
repository (a single repo can back more than one product).

## Release events refresh the truth store

The same endpoint also accepts GitHub's `release` event, and treats every action it sends —
`published`, `unpublished`, `created`, `edited`, `deleted`, `prereleased`, `released` — the
same way: for each product linked to the delivery's repository, it re-runs the
[truth-store](/docs/services/release/truth-store/) half of a resync and nothing else. Publishing
a build therefore shows up in the console's Releases page and the customer portal within one
delivery, without a push to `.pkey/` and without anyone pressing **Resync from repo**.

The guards are the push path's, in the same order: the signature is verified over the raw body
before anything is parsed, the delivery GUID is recorded before the event is dispatched (so a
replayed release delivery is answered "ignored" and writes nothing), and the delivery's
installation id must match the one recorded for each product — a mismatch is reported for that
product and writes nothing for it.

What a release delivery does **not** do matters as much:

- **It never trusts the payload's release.** Only the repository's owner and name and the
  installation id are read from the body. The store is refreshed by listing releases from
  GitHub with the installation token — the same paginated, floor-aware read a resync makes — so
  a forged or stale `release` object in a delivery cannot put anything into the store.
- **It never touches the manifest.** `.pkey/` is not read, no manifest-owned row is written,
  and the [sync-state row](#sync-state--changed-paths-in-the-console) is left alone: that row
  records the _manifest_ sync, and a release event overwriting it would hide a failed one.
  `release_health.checked_at` is the release refresh's own record.
- **It never deletes.** A release that is deleted, or unpublished back to a draft, keeps its
  rows; once a sync has read the whole release list and it is no longer there, its
  `release_health` subject turns `degraded` with `absentUpstream: true`. A list cut short by the
  10-page cap marks nothing, because absence from a partial read proves nothing. Deleting a
  release that was a channel's head is also what trips that channel's
  [floor](/docs/services/update/eligibility/#channel-floors-no-silent-downgrade).

Each release delivery costs one installation-token read (normally a KV hit) plus the release
list pages — one call for a repository with fewer than 100 releases. That is cheap at release
cadence; bursts are not coalesced.

## Pinned to the repo's own default branch, never to the webhook payload

`resyncRepo` takes **no ref**. Earlier revisions of this pipeline read `payload.after` — an
attacker- or reviewer-bypassable value inside the webhook body — and applied whatever
commit it named. Today the Contents API is asked for `.pkey/schema`, `.pkey/product`, and
`.pkey/release` with no `ref` parameter at all, which makes GitHub itself resolve the
linked repository's own default branch, server-side, from the coordinates already stored
in the product's release configuration. Nothing in the request body ever selects which
commit gets applied — branch protection and required review on `.pkey/` stay meaningful,
because the only path to "what got applied" runs through GitHub's own branch resolution,
not through a payload field.

The push's commit SHA (`payload.after`) is still recorded — but only as an audit value, in
the console's sync-state display, never as a fetch parameter.

## What a resync touches

A resync re-parses the manifest and re-applies it as a diff against the product's current
state:

- **Always fully replaced** from the manifest, every sync: the release configuration row
  (channel workflow, binary name, Sparkle key, access modes, and the `stableTagPattern` /
  `ignoreTags` candidate filter), the config catalog (only
  when its content actually changed, which publishes a new schema version), OIDC
  configuration, tiers, profiles, provisioning rules, and edge-mint recipes. A tier or
  profile still referenced by a live license blocks its own removal rather than silently
  orphaning that license.
- **The release truth store** — refreshed in the same pass, with one paginated release
  listing against the same installation token. It follows GitHub's `Link: rel="next"` for up
  to 10 pages of 100 (1,000 releases), so a busy repository cannot push its last stable release
  out of the store. A repository with fewer than 100 releases still costs one call. The same
  pass raises each moving channel's [floor](/docs/services/update/eligibility/#channel-floors-no-silent-downgrade).
  See [The truth store](/docs/services/release/truth-store/) for what that populates.

Removing a repository-side field returns the corresponding server value to its default,
not to whatever it last was — a manifest is the whole statement of intent, not a set of
patches.

## Manifest-vs-admin ownership

Three specific settings — the **fingerprint policy**, the **auto-issue policy**, and
**service enablement** (which carries the device registration policy alongside it) —
follow a different rule than everything above: manifest-owned until an operator changes
one of them live in the console, at which point it is admin-claimed and a later resync
skips it entirely rather than overwriting the operator's change. A push cannot quietly
undo a change an operator made at 3 a.m. to stop an incident.

`POST …/services/revert` (and its equivalents for the other two) hands ownership back to
the manifest without changing the live value — the setting stays exactly as the operator
left it until the next resync re-applies whatever the repository currently says.

Everything else described above has no such flag: release configuration, the catalog,
OIDC, tiers, profiles, provisioning, and edge-mint recipes are always manifest-owned. There
is no per-field release API in the admin surface — editing `.pkey/release` and resyncing
_is_ the edit path.

## Sync state & changed paths in the console

Every resync attempt — manual or webhook-triggered — writes one row recording what
happened: its source (`manual` from the console button, or `webhook` from a push), whether
it succeeded, when it was last checked and last actually synced, the commit SHA the push
named, the changed paths that triggered it, which sections were updated, and any validation
errors. The **Last sync** section of the Releases page's **Repo sync** drawer is a direct
read of that row, every list in full — it is how an operator confirms that a push actually
landed, and reads the validation errors verbatim when it didn't. A `release` delivery never writes this row; its trace is the
`checked_at` of the product's `release_health` rows.

## The manual resync action

**Resync from repo** in the console calls the same `resyncRepo` path the webhook does,
synchronously, and only for a product whose `release_source` is actually `github`. A
manually created product has nothing to resync from (the endpoint answers `422`), so its
Settings page offers **Link repository…** instead: it checks the repository, shows what the
manifest will apply, keep and remove, then links the product and applies the manifest through
this same path (see
[Linking a repository to an existing product](/docs/admin/products/#linking-a-repository-to-an-existing-product)). When the resync finishes, the **Repo sync** drawer lists what it updated,
any part of the manifest it refused (with the manifest path), and the pack-set
re-resolution it triggered. Use it after linking a repo whose
`.pkey/` predates the App installation, or any time an operator wants to confirm a change
landed without waiting on a webhook delivery.

## Binary name safety

A product's binary name is repository-controlled, and it is interpolated into the curl-pipe
install script every user of that product pipes straight into `sh`. It is validated against
a strict character class at _every_ point it can enter the system — both ingest paths
(link and resync) and the installer renderer itself — so a manifest cannot smuggle a value
the renderer would later refuse. See
[Artifacts, changelog & install](/docs/services/release/artifacts/) for how the installer
uses it.

## See also

- [The truth store](/docs/services/release/truth-store/) — what a sync actually populates,
  and the health checks built on it.
- [Artifacts, changelog & install](/docs/services/release/artifacts/) — what gets served
  once a repo is linked.
- [JSON Schema & editor setup](/docs/build/manifest/json-schema/) — editor validation for
  `.pkey/` documents.
- [Public route table](/docs/reference/routes/) for the admin sync/health/releases paths.
