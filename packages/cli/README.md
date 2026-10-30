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
[Installing the SDKs from the feeds](https://key.plrs.im/docs/build/install/)):

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
          [--release-owner owner] [--release-repo repo] [--force]
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

Exit codes: `0` success, `1` a validation or runtime failure (an invalid manifest, a refused
request, a network error), `2` a usage error (an unknown command or subcommand, a missing or
misused flag; the message shows the usage). A failure never prints a stack trace; `PKEY_DEBUG=1`
adds one to an unexpected error.

### Help

`pkey <command> --help`, `pkey <command> -h` and `pkey help <command>` print that command's usage
lines, the paragraphs that explain it, and the environment variables it reads, and exit `0` **without running the command** — `pkey init --help` writes no
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

Text a server sends (a refusal's message, a release id, a label, a URL) is printed as text, never
as an escape: every control character is removed before it reaches the terminal, so a field
cannot write the clipboard, clear the screen or start a line of its own. Inside GitHub Actions
(`GITHUB_ACTIONS` set) it also never reads as a workflow command: a value that would begin a line
with `::`, or holds `##[`, carries an invisible U+200B, and the only commands `pkey` and the Action
write are their own `::add-mask::` lines and the Action's `::error` annotation. In a job log
`pkey`'s own colour (under `FORCE_COLOR`) survives; no other escape does.

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
pkey init --product djdl --modules license,config,release,distribution,update,identity \
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
copy. See [JSON Schema & editor setup](https://key.plrs.im/docs/build/manifest/json-schema/) for the full editor
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
each message is one plain line. `--json` prints one JSON line on stdout instead, the terminal kits'
result line: the envelope's `v`, `command`, `event`, `ok` and `exit`, and the verdict's own fields
beside them (the Node and Python CLI kits use the same flattened envelope; shown here
pretty-printed):

```json
{
  "v": 1,
  "command": "validate",
  "event": "result",
  "ok": false,
  "exit": 1,
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
```

(Printed on one line.) `at` is the document and JSON pointer, `file` the file it was read from
relative to the current directory (`null` when the document is missing). The CLI's own warning
that one document exists under two extensions has `"code": null` and `"at": ".pkey/"`. When no
manifest can be read at all (a file problem) the line is
`{"v":1,"command":"validate","event":"result","ok":false,"exit":1,"error":"no-manifest","message":"…"}`,
with the `message` for people, and the exit code is `1`. Every non-ASCII character is written as a
`\u` escape. Human output (everything without `--json`) may change between releases; scripts read
`--json`.

The full code list is at [Manifest validation codes](https://key.plrs.im/docs/reference/validation-codes/).

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
[Distribution: outlets, transports and listing](https://key.plrs.im/docs/build/manifest/distribution/).

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

Shows one `kid`/public-key pair as every SDK's config file holds it: the Node and React
`trust.pinnedKeys`, Python's `PINNED_KEYS`, Swift's `pinnedKeys`, Kotlin's `pinnedKeys` and Godot's
`PINNED_TRUST_KEYS`. These are the modules `pkey sdk` writes, from the same renderer
(`@polaris-key/manifest/integration`), so wiring a newly minted or rotated signing key into every
codebase is one copy per language.

```sh
pkey trust --kid pkey-djdl-prod-2026-06 --public-key <base64url>
```

### `pkey sdk`

Without `--lang`, prints the Node setup for `--product`: the config module and the start,
including the trust pin when `--kid`/`--public-key` are also given. `--base-url` defaults to
`https://key.plrs.im`, the same production origin every other command uses (`DEFAULT_BASE_URL`),
so the snippet works as pasted for a product hosted there. Pass `--base-url` for a self-hosted
deployment.

`pkey sdk add <lang> --expect <kid>@sha256:<fingerprint>[,...]` does the same as
`--lang <lang> --write`, but refuses unless discovery serves exactly the pins `--expect` names, by
fingerprint (copy them from the console's Integration page): there is no trust on first use. It
then prints the install lines from `pkg.plrs.im`, routing the name to the feed first, and the
start for the SDK. A missing flag is named in the error.

With `--lang`, it writes a typed configuration module for one SDK from the product's live
discovery document (`<base>/<product>/.well-known/polaris.json`, with the same `--base-url`
default). The module carries the product slug, the base URL, the trust pins, the pinned release
keys and the services the product runs, in that SDK's own option names, so the app adds only its
version:

| `--lang` | Default `--out`       | Use it as                                                            |
| -------- | --------------------- | -------------------------------------------------------------------- |
| `node`   | `polaris.config.ts`   | `PolarisKeyClient.create({ ...polarisConfig, version })`             |
| `react`  | `polaris.config.ts`   | `<PolarisKeyProvider {...polarisConfig} version={…}>`                |
| `python` | `polaris_config.py`   | `PolarisKeyClient.create(**polaris_config.CONFIG, version=…)`        |
| `swift`  | `PolarisConfig.swift` | `PolarisKeyClient(options: PolarisConfig.clientOptions(version: …))` |
| `kotlin` | `PolarisConfig.kt`    | `PolarisKeyClient.create(PolarisConfig.clientOptions(version = …))`  |
| `godot`  | `polaris_key.tres`    | `await PolarisKey.boot()` (reads `res://polaris_key.tres`)           |

An `--out` ending in `.js` or `.mjs` gives Node and React a JavaScript module (checked with
`@satisfies`). Kotlin's package is `--package` (default `polaris.generated`). Without `--write`
the module goes to stdout; with it, the file is written and each pin's SHA-256 fingerprint is
printed. `--write` replaces only a file it wrote before (the `GENERATED by \`pkey sdk`banner)
unless`--force` is given.

Godot has one file, `polaris_key.tres` beside `project.godot` (found by walking up from the
working directory; none is an error unless `--out` is given). `--write` puts `product_slug`, `base_url`,
`pinned_keys`, `pinned_release_keys` and `expected_services` into it and leaves every other
property (the channel, theme and update settings the setup dock wrote) as it was, except that it drops the
pre-0.9 `product` and `pinned_trust_keys` lines and adds a comment naming the SDK version that reads the new ones; run twice, the
second run changes nothing. A project without the file gets a new one. A `polaris_key_config.gd`
from an earlier version is no longer read: the command says so and leaves it alone.

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
[Going offline](https://key.plrs.im/docs/features/licensing/offline/) and, at the protocol level, in
[Offline bundles](https://key.plrs.im/docs/reference/protocol/bundles/). `--device`,
`--grace-days`, `--base-url` and the admin API token are all validated locally (32 base64url
characters; an integer 1–365; an `https:` or loopback origin; `pkeya_` + 43 base64url
characters) before any network call, and the output path is checked for a collision before
**and** after the mint, because a mint is an audited, non-free server-side event — discovering
the output file already exists only after minting would burn a bundle to learn something
knowable up front.

```sh
PKEY_ADMIN_TOKEN='pkeya_<admin API token>' \
  pkey bundle --product djdl --device <deviceId> --grace-days 365
# Minted bundle <ULID>
# - File: djdl-<first 8 of device id>.pkeybundle
# - Device: <deviceId>
# - Grace window: 365 days offline
#
# Next: transfer this file to the offline device and import it there.
```

`--grace-days` is capped at 365 (`MAX_GRACE_DAYS`), enforced both here and again by the
verifier; `--no-config` omits the config document even when Config is enabled; `--license` is
required whenever the product's License service is enabled — the server has no authenticated
device to infer a licence from, so it never guesses even when there is only one candidate;
`--base-url` defaults to `https://key.plrs.im`; `--out` defaults to
`<product>-<first 8 of device id>.pkeybundle`, resolved against the current directory.

#### `PKEY_ADMIN_TOKEN`

`pkey bundle` authenticates with an **admin API token**, sent as `Authorization: Bearer
pkeya_…` and read from `PKEY_ADMIN_TOKEN`. That is the whole credential: no cookie, no
`X-PKey-CSRF` header, and no `GET /manage/api/me` pre-flight — a token-authenticated request is
CSRF-exempt (nothing but the caller attaches an `Authorization` header, so there is no ambient
credential for a cross-site page to forge), which leaves the command at exactly one network
call.

To obtain one: in the console, go to **API tokens → New token**, give it a label naming where
it will run and an expiry (1 to 365 days), and copy the value. It is shown **once**, at mint —
the server stores only a hash, so nothing can reproduce it later. Then:

```sh
export PKEY_ADMIN_TOKEN='pkeya_<43 base64url characters>'
```

This replaced an exported `__Host-pkey_admin` session cookie, and the reasons are worth stating:
a session cookie could not be narrowed (it carried the operator's whole admin authority), could
not be revoked without killing every session that human held, was indistinguishable in the audit
log from that human clicking in the console, and expired on the session's schedule. A token is
scoped to `bundles:mint` — which covers exactly `POST /manage/api/products/<slug>/bundles`, and
every other admin route refuses a token outright — individually revocable, attributed separately
as `token:<id>` in the audit trail, and expires when you said it would.

It is still a credential that can mint a bundle for **any** product on the platform: do not
commit it, script it into a file, paste it into a ticket, or export it into a shell other people
share. A `401` means the token is unknown, revoked or expired (the server answers one status for
all three on purpose; the console's roster says which). A `403` means either that the token is
not scoped for the route or that the identity behind it is not a platform admin.

The CLI checks the token's **shape** locally before it sends anything, so a pasted cookie or a
truncated copy costs a sentence rather than an uninformative 401. `--base-url` is checked the
same way and must be `https:` — or `http:` on `localhost`/`127.0.0.1` for local development —
because that flag decides which origin receives a full-authority bearer credential. The bundle
file is created with mode `0600` and is never written through a symbolic link: without `--force`
an existing file is refused by the kernel (`O_EXCL`), and `--force` truncates a regular file and
tightens its mode but still refuses a link.

`pkey bundle`, `pkey migrate` and `pkey listing import` all use the same credential: the sign-in
`pkey login` saved, or a token in `PKEY_ADMIN_TOKEN` (`pkeyp_` for any of them; `pkeya_` for
`bundle` and `migrate`, never for `listing import`). A person who lacks the access gets a refusal
that names the product and area, their roles and who to ask, and the command exits 4.

### Boolean flags

`--no-config`, `--force`, `--dry-run` and the other boolean flags take no value, so none of them
takes the next word: `pkey init --force dir` and `pkey validate --json game` keep `dir` and `game`
as arguments. `--force=true` is accepted too. The global flags `--help`, `-h`, `--no-color`,
`--color` and `--ascii` never take a value either.

## Develop

```sh
pnpm --filter @polaris-key/cli typecheck
pnpm --filter @polaris-key/cli test
pnpm --filter @polaris-key/cli build
```
