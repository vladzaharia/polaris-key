# @polaris-key/cli

`pkey` — the platform CLI for **product owners** authoring and operating a `.pkey/` manifest:
scaffold it, validate it, sanity-check it against a live deployment, generate copy-paste trust
and SDK snippets, and mint offline activation bundles. It is not a client library: an end
user's app activates a license through a language SDK (`@polaris-key/node`, `polaris-key` on
PyPI, …), not through this tool. `pkey` is what the _product's_ repo runs in CI and what an
operator runs from a terminal.

## Install

The `@polaris-key` packages are published to Polaris Key's npm feed only (not npmjs). Route the
scope to it once, in the project's `.npmrc` (Yarn, Bun and the rest:
[Installing the SDKs from the feeds](/docs/build/install-from-feeds/)):

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

```sh
pnpm add -D @polaris-key/cli
# or run it without installing:
pnpm dlx @polaris-key/cli --help
```

Node 22+. The package exposes one binary, `pkey` (`./dist/bin/pkey.js`), and the same command
core as a library (`import { runPkey } from "@polaris-key/cli"`) for embedding in another tool.
Without Node, the same CLI is an image: `docker run --rm -v "$PWD:/work"
pkg.plrs.im/polaris-key/pkey:latest validate`.

## Commands

`pkey` (or `pkey help`, `pkey --help`, `pkey -h`) prints every command, grouped (Manifest, SDK and
tools, Offline bundles, CI release, Distribution, Feeds, Listing and assets, Transport, Storefront,
Shell), and `pkey <command> --help` prints one command's usage lines and notes. The most used:

```
pkey init [--product slug] [--name name] [--modules license,config,release,distribution,update,identity,sync]
          [--admin-group group] [--release-owner owner] [--release-repo repo] [--force]
pkey validate [path] [--json]
pkey distribution outlet-ids --outlet id
pkey doctor [--base-url url --product slug]
pkey trust --kid kid --public-key key
pkey sdk --product slug [--base-url url] [--kid kid --public-key key]
pkey sdk --lang node|react|python|swift|kotlin|godot [--product slug] [--base-url url]
         [--write [--out path] [--force]] [--kid kid --public-key key]
         [--release-key kid=key ...] [--package kotlin.package]
pkey mirror --lang ts,python,swift,gdscript,kotlin [--out-dir dir]
            [--catalog file | --product slug [--base-url url]] [--package kotlin.package] [--check]
pkey bundle --product slug --device id --grace-days n [--no-config] [--license id]
            [--base-url url] [--out file] [--force]
pkey completion bash|zsh|fish
pkey help [command]   # also pkey --help / -h, and pkey <command> --help / -h
```

Exit codes: `0` success, `1` a validation/runtime failure, `2` an unrecognized command or a
usage error (`pkey completion` without a shell it knows).

### Help

`pkey <command> --help`, `pkey <command> -h` and `pkey help <command>` print that command's usage
lines, the paragraphs that explain it, the environment variables it reads and a note on its
valueless flags, and exit `0` **without running the command** — `pkey init --help` writes no
files, `pkey release publish --help` sends nothing. A subcommand narrows it
(`pkey release publish --help`, `pkey help feeds prune`). `--help` and `-h` count anywhere before a
bare `--`; after it (`pkey storefront exec … -- <argv>`) they belong to the store's command.

### Terminal output

`pkey` draws with the same terminal primitives as the Node SDK's CLI kit
(`@polaris-key/node/terminal`; docs/design/UI-KITS.md §1.4): ANSI-16 roles (strong headings,
muted descriptions, `✓` success, `▲` warning, `✗` danger), 80 columns that degrade to the
terminal's width (legible at 60). Colour appears only when stdout is a terminal: `NO_COLOR=1`,
`--no-color`, `TERM=dumb` and a pipe give plain text with no escape sequences, and `FORCE_COLOR`
(or `--color`) forces it. `--ascii`, `TERM=dumb` and `PKEY_ASCII=1` swap the symbols for ASCII
(`+`, `!`, `x`). Machine output — `--json`, `distribution outlet-ids`, the `trust`, `sdk` and
`feeds setup` snippets — is never styled.

The long commands (`pkey release publish`: hashing, the upload ticket, uploading, submitting;
`pkey listing assets`: reading, encoding, uploading, registering) show one spinner line per stage
on **stderr**, only when stderr is a terminal and never under CI (`CI`, `GITHUB_ACTIONS`). The
line is erased before anything else is printed, and stdout is byte for byte what it is in a
pipe.

### Shell completion

`pkey completion bash|zsh|fish` prints a completion script generated from `pkey`'s own command
table: the commands, their subcommands (`release publish|content-stamp|revoke|keys|delegate|
promote|pin|unpin|yank`, `transport apple-ba package|upload`, …) and each command's flags.

```sh
eval "$(pkey completion bash)"                           # in ~/.bashrc
eval "$(pkey completion zsh)"                            # in ~/.zshrc, after compinit
pkey completion fish > ~/.config/fish/completions/pkey.fish
```

### `pkey init`

Scaffolds `.pkey/` in the current directory: `product.yaml` and `schema.yaml` always
(ingest requires both, even with Config off; without `config` the schema is an empty catalog),
`release.yaml` when Release is. The scaffolded tier is `policyDeviceLimit: 5` with no expiry
field, so its licences do not expire. `--modules` takes either vocabulary: the service slugs
(`license`, `config`, `release`, `distribution`, `update`, `identity`) or the legacy module
names `.pkey/product`'s `modules` block still accepts (`licensing`, `releases` = release +
distribution + update, `oidc`, `edgeMint` = config). The scaffold always writes the `modules` block in service slugs,
one line per service. Omit `--modules` and you get `license,config`, matching what every
product ran before the service suite existed. `--product`/`--slug` default to the current directory's name,
lowercased and reduced to `[a-z0-9-]`; `--name` defaults to a titleized version of the slug.
Existing files are never overwritten without `--force`.

```sh
pkey init --product djdl --modules license,config,release,distribution,update,identity --admin-group djdl-admins \
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

Reads `.pkey/` under `path` — relative to the current directory, default the current directory
(`product.{json,yaml,yml}` required; `schema`, `release` and `distribution` read if present) — and
runs it through `@polaris-key/manifest`'s `validateIngestDocuments`: the same presence rule plus
validator that repo-link and resync apply, so a missing `.pkey/schema` is `missing_schema` locally
too. Prints a verdict, the resolved service-slug vocabulary regardless of which vocabulary the
manifest wrote in, any required secret names, then every warning (`▲`) and error (`✗`) with its
document, JSON-pointer path and the file it was read from. Exit `0` when valid, `1` when not.

```
$ pkey validate game
✗  Manifest: invalid
   Modules: config, release, update
▲  warning product/modules/config (game/.pkey/product.yaml): Config is enabled without an activation method.
✗  error release/: Releases are enabled, so .pkey/release.yaml or release.json is required.
```

On a terminal the roles are coloured and a long message wraps under its own column; anywhere else
each message is one plain line. `--json` prints one JSON object on stdout instead, in the Node SDK
CLI kit's envelope:

```json
{
  "version": 1,
  "command": "validate",
  "ok": false,
  "exitCode": 1,
  "result": {
    "valid": false,
    "modules": ["config", "release", "update"],
    "requiredSecrets": [],
    "warnings": [
      {
        "code": "config_without_activation",
        "message": "Config is enabled without an activation method.",
        "at": "product/modules/config",
        "file": "game/.pkey/product.yaml"
      }
    ],
    "errors": [
      {
        "code": "missing_release",
        "message": "Releases are enabled, so .pkey/release.yaml or release.json is required.",
        "at": "release/",
        "file": null
      }
    ]
  }
}
```

(Printed on one line.) `at` is the document and JSON pointer, `file` the file it was read from
relative to the current directory (`null` when the document is missing). The CLI's own warning
that one document exists under two extensions has `"code": null` and `"at": ".pkey/"`. When no
manifest can be read at all, `result` is replaced by
`"error": {"code": null, "title": "No manifest read", "message": "…"}` and the exit code is `1`.

The full code list is at [Manifest validation codes](/docs/reference/validation-codes/).

### `pkey distribution outlet-ids`

Prints the store ids a Godot export stamps into a build (P1-11's `outletIds`), from
`.pkey/distribution`, as one compact JSON object with sorted keys and **every value a string** —
for CI to pass as `PKEY_OUTLET_IDS`:

```sh
$ pkey distribution outlet-ids --outlet ms-store
{"caskToken":"dice","itchGameId":"1001","msixFamilyName":"Vlad.Dice_abcdefghjkmnp","steamAppId":"480"}
```

`--outlet` names the build's outlet entry and is required. The keys are `steamAppId`,
`itchGameId`, `flatpakId`, `snapName`, `caskToken` and, for an `ms-store` or `app-installer`
build, that entry's `msixFamilyName`; an absent id is left out. With no `.pkey/distribution` it
prints `{}` and exits `0` for any `--outlet`. With one, the manifest must validate and declare the
outlet, or the command exits `1` with the reason on stderr. See
[Distribution: outlets, transports and listing](/docs/build/manifest/distribution/).

### `pkey doctor`

Runs `validate` first, always. Pass **both** `--base-url` and `--product` to additionally
fetch `GET <base-url>/<product>/.well-known/polaris.json` and report whether discovery
answers (`Remote discovery: ok <url>`), which services it advertises as enabled
(`Services enabled: license, config`, or `none`), and which signing keys it exposes
(`Signing keys exposed: …`) — a fast way to confirm a repo-linked product is
actually live before wiring an SDK to it. Omit either flag and the remote check is skipped
with a note, and `doctor`'s exit code is `validate`'s; a failed _remote_ check (a non-2xx
response) overrides that and exits `1` on its own, since "the product isn't answering" is a
harder failure than any local warning.

### `pkey trust`

Formats one `kid`/public-key pair as ready-to-paste snippets for every SDK at once — JSON,
the Node/React `trust: { pinnedKeys: {…} }` shape, Python's `trusted_keys = {…}`, Swift's
`let trustedKeys = […]`, and Godot's `const PINNED_TRUST_KEYS := {…}` (for
`PKeyOptions.pinned_trust_keys`, or the setup dock's pinned-keys field) — so wiring a newly-minted or rotated signing key into every codebase
that consumes it is one copy per language, not one hand-transcription per language.

```sh
pkey trust --kid pkey-djdl-prod-2026-06 --public-key <base64url>
```

### `pkey sdk`

Without `--lang`, prints a ready `@polaris-key/node` quick-start snippet
(`PolarisKeyClient.create({...})`, `sync()`, a `getConfig`/`getSecret` example) for `--product`,
including a `trust:` block when `--kid`/`--public-key` are also given. `--base-url` defaults to the
placeholder `https://key.example.com` — deliberately **not** the real `https://key.plrs.im`
default that `bundle`/`doctor` use, so a snippet pasted without editing cannot silently point a
new product at Polaris Key's own production origin.

With `--lang`, it writes a typed configuration module for one SDK from the product's live
discovery document (`<base>/<product>/.well-known/polaris.json`; `--base-url` defaults to
`https://key.plrs.im` here, since the facts are fetched, not pasted). The module carries the
product slug, the base URL, the trust pins, the pinned release keys and the services the product
runs, in that SDK's own option names, so the app adds only its version:

| `--lang` | Default `--out`         | Use it as                                                                |
| -------- | ----------------------- | ------------------------------------------------------------------------ |
| `node`   | `polaris.config.ts`     | `PolarisKeyClient.create({ ...polarisConfig, version })`                 |
| `react`  | `polaris.config.ts`     | `<PolarisKeyProvider {...polarisConfig} version={…}>`                    |
| `python` | `polaris_config.py`     | `PolarisKeyClient.create(**polaris_config.CONFIG, version=…)`            |
| `swift`  | `PolarisConfig.swift`   | `PolarisKeyClient(options: PolarisConfig.clientOptions(version: …))`     |
| `kotlin` | `PolarisConfig.kt`      | `PolarisKeyClient.create(PolarisConfig.clientOptions(version = …))`      |
| `godot`  | `polaris_key_config.gd` | `PolarisKey.configure(preload("res://polaris_key_config.gd").options())` |

An `--out` ending in `.js` or `.mjs` gives Node and React a JavaScript module (checked with
`@satisfies`). Kotlin's package is `--package` (default `polaris.generated`). Without `--write`
the module goes to stdout; with it, the file is written and each pin's SHA-256 fingerprint is
printed. `--write` replaces only a file it wrote before (the `GENERATED by \`pkey sdk`banner)
unless`--force` is given.

**Trust.** Pins are compiled into the app, never learned at runtime; reading them from discovery
is a build-time convenience over HTTPS (`http:` only for localhost). Compare the printed
fingerprints with the console before shipping, or pass the `pkey trust` pair as
`--kid`/`--public-key`, and the command refuses unless discovery serves exactly that pin.

**Release keys** have no public route: they come from the product repo's `.pkey/release`
`releaseKeys` (run the command in that repo; its product slug must match `--product`) or from
`--release-key kid=key`. They are matched against discovery's `release.releaseKeyFingerprints`
both ways, and the command refuses, writing nothing, when a declared key is not advertised (push
and resync first), when an advertised key was not declared, or when a release key is also a trust
pin.

Every module is pinned by a sample each SDK compiles against its real API (see
`packages/cli/test/sdkConfig.test.ts`).

### `pkey mirror`

Writes the typed catalog mirrors (`catalog.generated.ts`, `catalog_generated.py`,
`ConfigSchema.generated.swift`, `catalog_generated.gd`, `ConfigSchema.generated.kt`) that the
monorepo's `tools/gen-mirrors.ts` writes, from the same renderers, so a product gets compile-time
config keys without the monorepo. The catalog comes from `--catalog <file>` or from the product's
public schema route (`--product`, `GET <base>/<product>/config/schema`). `--check` writes nothing
and exits `1` when a mirror is stale, for CI.

```sh
pkey mirror --lang ts,python --product acme --out-dir src/generated
pkey mirror --lang kotlin --catalog catalog.json --package com.acme.catalog --check
```

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

`--no-config`, `--force`, `--dry-run` and the other boolean flags take no value. The argument
parser hands a _valueless_ flag the next bare word as its value if that word doesn't itself start
with `--`, so placing one of these immediately before a positional argument would swallow it.
The safe habit is to pass boolean flags **last**, or spelled out as `--no-config=true` /
`--force=true`; each command's `--help` ends with a note naming its valueless flags. The global
flags `--help`, `-h`, `--no-color`, `--color`, `--ascii` and `--json` never take a value, so
`pkey validate --json game` validates `game`.

## Develop

```sh
pnpm --filter @polaris-key/cli typecheck
pnpm --filter @polaris-key/cli test
pnpm --filter @polaris-key/cli build
```
