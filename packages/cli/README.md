# @polaris-key/cli

`pkey` — the platform CLI for **product owners** authoring and operating a `.pkey/` manifest:
scaffold it, validate it, sanity-check it against a live deployment, generate copy-paste trust
and SDK snippets, and mint offline activation bundles. It is not a client library: an end
user's app activates a license through a language SDK (`@polaris-key/node`, `polaris-key` on
PyPI, …), not through this tool. `pkey` is what the _product's_ repo runs in CI and what an
operator runs from a terminal.

## Install

```sh
pnpm add -D @polaris-key/cli
# or run it without installing:
pnpm dlx @polaris-key/cli --help
```

Node 22+. The package exposes one binary, `pkey` (`./dist/bin/pkey.js`), and the same command
core as a library (`import { runPkey } from "@polaris-key/cli"`) for embedding in another tool.

## Commands

```
pkey init [--product slug] [--name name] [--modules licensing,config,releases,oidc,edgeMint]
          [--admin-group group] [--release-owner owner] [--release-repo repo] [--force]
pkey validate
pkey doctor [--base-url url --product slug]
pkey trust --kid kid --public-key key
pkey sdk --product slug [--base-url url] [--kid kid --public-key key]
pkey bundle --product slug --device id --grace-days n [--no-config] [--license id]
            [--base-url url] [--out file] [--force]
pkey help   # also --help / -h
```

Exit codes: `0` success, `1` a validation/runtime failure, `2` an unrecognized command.

### `pkey init`

Scaffolds `.pkey/` in the current directory: `product.yaml` always, `schema.yaml` when
`config` is among `--modules`, `release.yaml` when `releases` is. `--modules` takes the
**legacy** module vocabulary (`licensing`, `config`, `releases`, `oidc`, `edgeMint` — the same
names `.pkey/product`'s `modules` block still accepts and translates to the five service
slugs); omit it and you get `licensing,config`, matching what every product ran before the
service suite existed. `--product`/`--slug` default to the current directory's name,
lowercased and reduced to `[a-z0-9-]`; `--name` defaults to a titleized version of the slug.
Existing files are never overwritten without `--force`.

```sh
pkey init --product djdl --modules licensing,config,releases,oidc --admin-group djdl-admins \
  --release-owner vladzaharia --release-repo djdl
# Created 3 manifest files:
# - .pkey/product.yaml
# - .pkey/schema.yaml
# - .pkey/release.yaml
#
# Next: pkey validate
```

Each scaffolded file opens with an editor schema header —
`# yaml-language-server: $schema=../node_modules/@polaris-key/manifest/schemas/v1/<file>.schema.json`
— so VS Code / any `yaml-language-server`-backed editor offers completion and inline
validation immediately, with no separate setup step. The path climbs out of `.pkey/` into
`node_modules`, **not** a URL: the schemas' canonical `$id`s live on the docs site, which sits
behind the platform-admin session gate and which an editor cannot fetch, so the schemas ship
as files inside the `@polaris-key/manifest` npm package instead and the header points at that
copy. See [JSON Schema & editor setup](/docs/build/manifest/json-schema/) for the full editor
story, including wiring VS Code's `json.schemas`/`yaml.schemas` settings for a monorepo that
keeps `.pkey/` somewhere other than one level under `node_modules`.

### `pkey validate`

Reads `.pkey/` from the current directory (`product.{json,yaml,yml}` required; `schema` and
`release` read if present) and runs it through `@polaris-key/manifest`'s
`validateManifestDocuments` — the same validator the Worker runs on repo-link and resync. One
gap: repo-link and resync also require a `.pkey/schema` file to exist on disk even when Config
is off (an empty catalog is enough), while `pkey validate` only requires the file once `config`
is among the enabled modules — so a Config-less manifest can validate clean locally and still be
refused on push. Prints the resolved
service-slug vocabulary regardless of which vocabulary the manifest wrote in, any required
secret names, then every warning and error with its file and JSON-pointer path:

```
Manifest: invalid
Modules: license, config, release, update
Required secrets: OIDC_CLIENT_SECRET
warning product/modules/config: Config is enabled without an activation method.
error release//: Releases are enabled, so .pkey/release.yaml or release.json is required.
```

The full code list is at [Manifest validation codes](/docs/reference/validation-codes/).

### `pkey doctor`

Runs `validate` first, always. Pass **both** `--base-url` and `--product` to additionally
fetch `GET <base-url>/<product>/.well-known/polaris.json` and report whether discovery
answers and which signing keys it exposes — a fast way to confirm a repo-linked product is
actually live before wiring an SDK to it. Omit either flag and the remote check is skipped
with a note, and `doctor`'s exit code is `validate`'s; a failed _remote_ check (a non-2xx
response) overrides that and exits `1` on its own, since "the product isn't answering" is a
harder failure than any local warning.

### `pkey trust`

Formats one `kid`/public-key pair as ready-to-paste snippets for all four SDKs at once — JSON,
the Node/React `trust: { pinnedKeys: {…} }` shape, Python's `trusted_keys = {…}`, and Swift's
`let trustedKeys = […]` — so wiring a newly-minted or rotated signing key into every codebase
that consumes it is one copy per language, not one hand-transcription per language.

```sh
pkey trust --kid pkey-djdl-prod-2026-06 --public-key <base64url>
```

### `pkey sdk`

Prints a ready `@polaris-key/node` quick-start snippet (`PolarisKeyClient.create({...})`,
`sync()`, a `getConfig`/`getSecret` example) for `--product`, including a `trust:` block when
`--kid`/`--public-key` are also given. `--base-url` defaults to the placeholder
`https://key.example.com` — deliberately **not** the real `https://key.plrs.im` default that
`bundle`/`doctor` use, so a snippet pasted without editing cannot silently point a new product
at Polaris Key's own production origin.

### `pkey bundle`

Mints one **offline activation bundle** (`POST /manage/api/products/<slug>/bundles`) and
writes it to a file — the operator half of the air-gapped activation flow described in
[Going offline](/docs/build/offline/) and, at the protocol level, in
[Offline bundles](/docs/build/wire/bundles/). `--device` and `--grace-days` are validated
locally (32 base64url characters; an integer 1–365) before any network call, and the output
path is checked for a collision before **and** after the mint, because a mint is an audited,
non-free server-side event — discovering the output file already exists only after minting
would burn a bundle to learn something knowable up front.

```sh
PKEY_ADMIN_COOKIE='__Host-pkey_admin=<console session cookie>' \
  pkey bundle --product djdl --device <deviceId> --grace-days 365
# Minted bundle <ULID>
# - File: djdl-<first 8 of device id>.pkeybundle
# - Device: <deviceId>
# - Grace window: 365 days offline
#
# Next: transfer this file to the offline machine and import it there.
```

`--grace-days` is capped at 365 (`MAX_GRACE_DAYS`), enforced both here and again by the
verifier; `--no-config` omits the config document even when Config is enabled; `--license` is
required whenever the product's License service is enabled — the server has no authenticated
device to infer a licence from, so it never guesses even when there is only one candidate;
`--base-url` defaults to `https://key.plrs.im`; `--out` defaults to
`<product>-<first 8 of device id>.pkeybundle`, resolved against the current directory.

#### `PKEY_ADMIN_COOKIE`

The admin API has exactly one credential today: the console's OIDC browser session — there is
no API-token surface yet. `pkey bundle` reads that session out of `PKEY_ADMIN_COOKIE`, uses it
to `GET /manage/api/me` for the session's CSRF token, and echoes that token in the `X-PKey-CSRF`
header on the mint — the same double-submit the console itself performs.

To obtain it: sign in to the console, open devtools → Application → Cookies → the console
origin, and copy the `__Host-pkey_admin` cookie. Then:

```sh
export PKEY_ADMIN_COOKIE='__Host-pkey_admin=<value>'
```

The bare value (no `name=`) is accepted too — the CLI prefixes the cookie name itself when the
variable holds no `=`. This is a **short-lived session credential carrying full admin
authority**: do not commit it, script it into a file, paste it into a ticket, or export it into
a shell other people share. A `401` means it is missing or expired; a `403` usually means it is
stale relative to the CSRF token `/manage/api/me` handed back for it.

### The valueless-flag gotcha

`--no-config` and `--force` take no value. The argument parser hands a _valueless_ flag the
next bare word as its value if that word doesn't itself start with `--`, so placing one of
these immediately before a positional argument would swallow it. None of today's commands
takes a positional after these flags, so the trap cannot spring in practice — but the safe
habit for any future command is to pass boolean flags **last**, or spelled out as
`--no-config=true` / `--force=true`.

## Develop

```sh
pnpm --filter @polaris-key/cli typecheck
pnpm --filter @polaris-key/cli test
pnpm --filter @polaris-key/cli build
```
