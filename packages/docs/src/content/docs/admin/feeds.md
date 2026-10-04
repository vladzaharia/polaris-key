---
title: "Package feeds"
description: "The console's Package feeds pages in both scopes: the overview, one page per feed (packages, setup, settings, activity), the package record with yank and deprecate, the platform policy and the admin API behind them."
sidebar:
  order: 14
---

A **package feed** serves one product's packages to one package manager from the registry host,
`pkg.plrs.im` (see [Package feeds](/docs/services/distribution/package-feeds/) for the host, the
URL layout and who may read). The console manages the feeds in two places, with the same pages:

- **Platform → Package feeds** (`#/platform/feeds`): the platform's own packages, the SDKs and
  tools Polaris Key ships. They belong to the system product, `polaris-key`, which stays out of
  the product switcher and the Products registry. This scope also holds the **platform policy**:
  each ecosystem's kill switch and size ceiling, above every product's own settings.
- **Distribution → Package feeds** (`#/p/<slug>/distribution/feeds`): one product's feeds. The
  sidebar lists it while the product's package feeds are on (**Core → Services → Package feeds**);
  with them off the page says where to turn them on. It is named "Package feeds" so it does not
  collide with **Outlets & feeds**, which covers storefront feeds.

Both scopes are for platform admins only, like the rest of the console.

## The overview

One row per ecosystem: npm, PyPI, Docker / OCI, Swift, Maven / Gradle and Godot. Each row shows
the feed's status, its packages and versions, the last publish, its access mode and its registry
URL with a copy button. The summary strip counts the feeds enabled, the packages, the versions and
the last publish.

A feed's status is one of:

- **Enabled**: the feed answers.
- **Off**: it answers not-found, with the reason under the pill — the product's Distribution or
  package feeds are off, the feed has no settings yet, or the feed is switched off.
- **Not available**: the platform policy has switched the ecosystem off for every product.

In platform scope, **Owners** lists every product whose package feeds have been switched, the
system product first. Before the platform's feeds are set up, the page offers **Set up platform
feeds**, which creates the system product and one feed per ecosystem with the platform's
namespaces (`POST /manage/api/platform/feeds/bootstrap`). Running it again changes nothing an
operator has set since.

The bar of links above each page title (Overview, a separator, then one link per ecosystem, each
with its icon) moves between the overview and the feed pages: each feed is a page of its own. The
current page is filled, bold and underlined on the bar's rule.

## A feed

Each feed page has four tabs, each a URL (`…/feeds/npm/settings`), and **Rebuild feed** under
More actions, which queues a fresh render of the feed's index documents.

- **Packages**: every package of the feed with its latest live version, its tags (npm dist-tags,
  OCI moving tags: the `stable` channel is `latest`, every other channel a tag of its own name),
  its live and total versions and its last publish. In platform scope the list opens on the
  platform's packages; **All owners** lists every product's, with an Owner column.
- **Setup**: what a client needs, copy-paste ready, for the feed's own URL and namespace: the
  `.npmrc`, `.yarnrc.yml` and `bunfig.toml` scope lines; a uv explicit index, a Poetry explicit
  source and a pip command (with the warning never to use `--extra-index-url`); SwiftPM's whole
  `registries.json` (the scope's registry and the signing policy); a Gradle `exclusiveContent`
  block and a Maven `<repository>`; `docker pull` by the fully qualified reference; or the Godot
  editor's URLs per editor version and the GodotEnv index. Every snippet routes only the feed's
  own names to it. The same snippets come from `pkey feeds setup` (below), byte for byte.
- **Settings**: see below.
- **Activity**: the feed's audit trail: settings changes, rebuilds and its versions' yanks and
  deprecations (and, in platform scope, the policy changes).

### Settings

Every section saves on its own, through its own Save bar, with the version of the settings it
read. If someone saved in between, the save is refused (409) and the page shows the current
settings; nothing is overwritten. A feed with no settings yet gets them on its first save.

| Section                 | What it sets                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General                 | Whether the feed answers. Switching it off asks first: every client then gets not-found within 30 seconds.                                                                                                                                                                         |
| Access                  | Who may install. Public is the only mode that can be set: Token, Licensed and Entitled are shown as unavailable, because the registry issues no credentials and any of them would refuse every client.                                                                             |
| Namespace               | The names the feed may hold, one row per namespace field the ecosystem's ingest rules declare: an npm or Swift scope, PyPI names and prefixes, Maven group prefixes, a Godot publisher. OCI repositories always sit under the owner. A feed cannot be enabled without a namespace. |
| Limits                  | The largest package ingest accepts, at most the platform's ceiling for the ecosystem.                                                                                                                                                                                              |
| Yank policy             | What a yank does to clients in this protocol. Maven only: **Hide yanked versions**, which leaves a yanked version out of `maven-metadata.xml`.                                                                                                                                     |
| Upstream                | None, the only option: a feed never proxies or mirrors another registry, so a name it does not hold answers not-found.                                                                                                                                                             |
| Simple API              | PyPI only: **HTML pages**, whether a client that cannot take PEP 691 JSON gets the inert PEP 503 HTML page (on) or 406 (off).                                                                                                                                                      |
| Signing and identifiers | Swift only: **Require signed releases** (ingest refuses an unsigned release; always on for the platform's own packages) and **Repository URLs**, one `identity url` per line, which `GET /identifiers?url=` answers from.                                                          |
| Retention               | OCI only: **Untagged manifests**, the days an image manifest no tag points at may be kept. It is stored only: nothing removes untagged manifests yet, so every one is kept whatever it holds. A published version is never removed.                                                |
| Asset listing           | Godot only: the asset library category, support level, license and oldest editor every addon of the feed is listed with.                                                                                                                                                           |
| Platform policy         | Platform scope only: whether the ecosystem is served at all, and its size ceiling, for every product. Switching an ecosystem off is a danger confirmation.                                                                                                                         |

## The package record

A package's page has three tabs: **Versions**, **Setup** (the feed's setup for this package and its
latest version) and **History** (the package's own audit rows).

Each version shows its tags, when it was published and how — a trusted-publisher run with a link to
the run, a static CI token by id, or the console — its size, each file's digests (SHA-256, and the
SHA-512, SHA-1 and MD5 the Worker computes for npm and Maven) with a copy button each, and its
state: **Live**, **Yanked** or **Deprecated**, with the reason or message.

The row actions follow the protocol, and only what the protocol has a state for is offered:

| Ecosystem | Yank                                                                      | Deprecate                                                     |
| --------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| npm       | No: npm has no yank that keeps lockfiles working                          | Yes: the version stays installable and npm prints the message |
| PyPI      | Yes (PEP 592): pinned installs work, resolvers skip it                    | No                                                            |
| Swift     | Yes: leaves the release list, stays fetchable                             | No                                                            |
| Maven     | Yes: marked yanked; hidden from `maven-metadata.xml` with the yank policy | No                                                            |
| OCI       | Yes: the version tag is removed, the digest stays pullable                | No                                                            |
| Godot     | Yes: leaves the asset listings                                            | No                                                            |

A yank needs a reason and is a danger confirmation; unyank, deprecate (with a message) and lifting a
deprecation are caution confirmations. There is no delete: a version number is unique forever, so a
yanked version can never be published again.

## Setup from the CLI

`pkey feeds setup` prints a feed's setup without the console, offline, from the same function the
Setup tabs use (`renderFeedSetup` in `@polaris-key/manifest`), so the two agree byte for byte:

```sh
pkey feeds setup --ecosystem npm --owner acme --namespace scope=@acme
pkey feeds setup --ecosystem maven --owner acme --namespace groupPrefixes=gg.acme,gg.acme.tools \
  --package gg.acme:sdk --version 1.2.0
pkey feeds setup --ecosystem pypi --owner acme --package acme-sdk --token-env PKEY_REGISTRY_TOKEN
```

`--namespace` takes the ecosystem's namespace fields (`scope`, `names`, `prefixes`,
`groupPrefixes`, `publisher`; a list takes commas). `--origin` points at another registry host
(default `https://pkg.plrs.im`). `--token-env NAME` adds each client's credential lines, reading
the registry token from that environment variable; the token itself is never an argument.
The registry issues no tokens yet (see Access above), and Swift's `/login` answers 501, so
`--token-env` output cannot authenticate until registry tokens arrive. Godot takes no
`--token-env`: the editor and GodotEnv authenticate by a token in the feed's URL.
`--json` prints the snippets as JSON.

## The admin API

The same handler set serves both scopes. It is narrative-only (not in the OpenAPI spec), like the
rest of the console's API.

| Method | Platform (`/manage/api/platform/feeds`)                    | Product (`/manage/api/products/<slug>/distribution/feeds`) | Audit action                             |
| ------ | ---------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| GET    | the base path: every feed, the owners                      | the base path                                              | —                                        |
| GET    | `/<eco>`: settings, policy, capabilities                   | `/<eco>`                                                   | —                                        |
| PUT    | `/<eco>/settings` (the system product's feed)              | `/<eco>/settings`                                          | `feed.settings.update`                   |
| PUT    | `/<eco>/policy`                                            | —                                                          | `feed.policy.update` (platform activity) |
| GET    | `/<eco>/packages?q=&owner=&cursor=`                        | `/<eco>/packages?q=&cursor=`                               | —                                        |
| GET    | `/<eco>/packages/<owner>/<name>`                           | `/<eco>/packages/<name>`                                   | —                                        |
| POST   | `…/versions/<version>/{yank,unyank,deprecate,undeprecate}` | the same                                                   | `package.version.*`                      |
| POST   | `/<eco>/rebuild`                                           | `/<eco>/rebuild`                                           | `feed.rebuild`                           |
| GET    | `/<eco>/activity`                                          | `/<eco>/activity`                                          | —                                        |
| POST   | `/bootstrap`                                               | —                                                          | `feed.bootstrap` (platform activity)     |

The settings and policy writes take `expectedVersion` (0 for a feed with no settings yet) and
answer 409 with `reason: "version_conflict"` and the current state when it is stale. A version verb
the protocol has no state for answers 422 with `reason: "unsupported_by_ecosystem"`; an access mode
other than `public` answers 422 with `reason: "access_mode_unavailable"`. Product-scoped writes are
audited under the owning product (the system product for the platform's feeds); the policy and the
bootstrap go to the platform activity.

The product's own switch is `GET`/`PUT /manage/api/products/<slug>/distribution/package-feeds`
(`{enabled, expectedVersion}`, audited `distribution.package_feeds.update`), the **Package feeds**
section of [Services](/docs/admin/services-enablement/).
