# P1-04 Godot config client: precedence, secrets, catalog fetch, edge-mint, typed mirrors

| Field       | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Phase       | P1: Godot SDK core                                                                            |
| Size        | 1–1.25 engineer-weeks                                                                         |
| Depends on  | [P1-02](P1-02-godot-core.md), [P0-12](P0-12-edge-mint-hardening.md)                           |
| Unblocks    | [P1-10](P1-10-godot-ui-kit.md)                                                                |
| Role        | `pkey-godot-engineer`                                                                         |
| Plan mode   | no                                                                                            |
| Gates       | `tools/gen-mirrors.ts` unit tests for the new `gdscript` target (`tools/gen-mirrors.test.ts`) |
| Human input | none                                                                                          |
| Repo        | `vladzaharia/polaris-key`                                                                     |

## Goal

`PolarisKey.config` resolves every key with the contract's precedence (enforced/hidden >
local override > environment > remote default > fallback), backed by a live local-override
provider over the game's own `ConfigFile`. It reads client-scoped secrets, fetches the catalog,
mints third-party tokens through edge-mint, emits `config_changed(keys)`, and binds values to node
properties. `tools/gen-mirrors.ts` gains a `gdscript` target that emits `catalog_generated.gd`.
Godot is the first SDK with an edge-mint client.

## Why

Managed config is what Diceroll adopts first: balance tuning, kill switches and settings
(report [§5.4](../../README.md#54-managed-config-in-a-game),
[§13](../../README.md#13-diceroll-adoption-path)).
In a game the layers map onto a `user://settings.cfg`, command-line arguments and engine APIs,
not onto `process.env` (notes/A2 §11). Secrets in the cache and a `.pck` are extractable, so the
safe path for third-party API keys is edge-mint, which no SDK implements
([PARITY §5.3](../../PARITY.md#53-config): `config.mint` is ✗ everywhere; report
[§9.1](../../README.md#91-polaris-key-worth-fixing-regardless-of-godot) #5 is why P0-12 comes
first). Feature ids: `config.resolve`, `config.list`, `config.secret`, `config.schema`,
`config.mint`, `config.mirror`.

## Read first

- `AGENTS.md`, the [P1-02](P1-02-godot-core.md) hand-off, and the P0-12 brief and PR (the mint
  authorisation rule and its error responses).
- Report [§5.3](../../README.md#53-transport-persistence-device-identity) ("Secrets"),
  [§5.4](../../README.md#54-managed-config-in-a-game).
- [notes/A2](../../notes/A2-sdk-port.md) §1.10, §4, §9.3, §11, §12.
- Reference code: `packages/client-core/src/config.ts:49-121` (env name, `looksLikeJson`,
  `resolveSource`, `resolveValue`, `listUserEntries`);
  `packages/sdk-node/src/config/client.ts:33,95-98`;
  `sdks/swift/Sources/PolarisKeyConfig/Fetch.swift:32` (`fetchSchema`, the only catalog fetch
  today); `packages/shared-catalog/src/types.ts:17-66` (`UiHints`, `ConfigEntry`, `accessor`).
- Server: `packages/worker/src/services/config/mint.ts`, and
  `packages/worker/openapi/polaris-key.v3.yaml` at `/{product}/config/mint/{mintId}/token`.
- `tools/gen-mirrors.ts:146-280` and `tools/gen-mirrors.test.ts`.
- Docs: `packages/docs/src/content/docs/services/config/catalog.md` (`accessor`, `delivery`).

## Scope

**In:**

- `services/config.gd` (`PolarisKey.config`): `get_value(key, fallback = null)`,
  `get_source(key) -> StringName` (`enforced`, `hidden`, `local`, `env`, `remote-default`,
  `fallback`), `list_user_config() -> Array[PKeyConfigEntry]` (no `hidden`; `enforced` flagged),
  `get_secret(key)` (string only, never enumerated, no override layers), `schema_version()`,
  `enabled()`, signal `config_changed(keys: PackedStringArray)`.
- **Local overrides:** `set_override_store(store)` with a `PKeyOverrideStore` interface and
  `PKeyConfigFileStore.new(path, mapping)` over a `ConfigFile`, keyed by each entry's `accessor`
  (`section.key` → `[section] key`), with an explicit table as fallback. Read at call time.
- **Environment layer:** `OS.get_environment(prefix + key.replace(".", "__"))` with prefix
  `PKEY_CONFIG_`, plus `--pkey-config key=value` user arguments; JSON-looking values parsed with
  `PKeyJson` using client-core's `looksLikeJson` rule. Off by default in release builds on
  mobile and web; a `PKeyOptions` flag turns it on.
- **Catalog fetch:** `await fetch_schema()` → `GET /<p>/config/schema` (unsigned,
  unauthenticated, UI hints only; cached in memory; `null` on any failure, never an error, as
  Swift does and P1b-07 ports under the same name).
- **Edge-mint:** `await mint_token(recipe_id) -> PKeyMintResult` (`token`, `expires_at`) via
  `GET /<p>/config/mint/<recipe_id>/token` with the device bearer, after checking discovery's
  `config.mint.available` and the recipe id against the router's pattern `^[a-z0-9-]+$`; an
  in-memory cache until `expires_at` minus 30 s; never persisted; typed results for 401, 404
  (unknown or not approved, per P0-12), 429 and 500, and `service-unavailable` when Config is
  off.
- `PKeyConfigBinding.bind_property(node, property, key, fallback)`, re-applied on
  `config_changed`.
- **Typed mirror:** a `gdscript` language in `tools/gen-mirrors.ts` (`Lang`, `FILENAME`,
  `RENDER`) writing `catalog_generated.gd` (`const CATALOG_VERSION`, `const ENTRIES`, a
  `DEFAULTS` dictionary, `entry_by_key`), with tests beside the TS, Python and Swift ones.
- A `config` unit suite ported from client-core's config cases, in the `ci` set.

**Out** (and where it belongs instead):

- `config-matrix.json` (→ [P1b-04](P1b-04-headers-config-corpora.md); the Godot runner loads it
  when it exists).
- Edge-mint and catalog fetch in Node, Python and Swift
  (→ [P1b-08](P1b-08-devicecode-edgemint-ports.md),
  [P1b-07](P1b-07-license-config-release-gaps.md)).
- Server-side mint authorisation (→ [P0-12](P0-12-edge-mint-hardening.md)).
- The settings panel UI (→ [P1-10](P1-10-godot-ui-kit.md)).
- A `gen mirrors --check` step in this repo's CI: `ci.yml` omits it on purpose until an
  in-repo product wires a catalog path (the comment in the `js` job), and Diceroll's catalog lives
  in its own repo.
- Shipping the mirror generator to adopters: it lives in `tools/` and is not published; exposing
  it through the `pkey` CLI is not owned by any work package yet.
- Keychain/Keystore storage for secrets (see Design notes; → P5 native plugins).

## Design notes

- **Precedence is contract and already implemented once** (`client-core/src/config.ts:79-110`).
  Port it line for line; the env-var name is `prefix + key` with every `.` replaced by `__`.
  Enforced and hidden keys **ignore** the saved player value without deleting it, so the player's
  choice returns if the operator relaxes the state (report §5.4).
- **Fallback:** `get_value(key, fallback)` returns the caller's fallback when nothing resolves; a
  call without a fallback uses `catalog_generated.gd`'s default if the game compiled one. Both
  report `fallback`. When P1b-04 lands, `config-matrix.json` decides; follow it.
- **Environment on desktop only by default.** macOS apps launched from Finder have no shell
  environment; web and mobile builds default the layer off (`OS.is_debug_build()` or an option).
  It can only affect `default` keys anyway.
- **Secrets are not secret in a game.** `clientScoped` values sit in `managed.json` and are
  extractable, like everything in a `.pck`; the README (P1-12) says so and points at edge-mint.
  The docs claim secrets go "into the OS keyring" (`catalog.md`); no SDK does that (report §9.1
  #20, notes/A2 §4). Do not repeat the claim.
- **Edge-mint tokens** live in memory only, per recipe id, and are refetched after expiry. A 401
  gets the normal single re-acquire (P1-03's rule) and then fails; nothing else is retried. The
  route contract is unchanged by P0-12 (`GET|POST`, `200 {token, expiresAt}`); what changes is
  that only operator-approved recipes answer, and discovery's `config.mint.available` says
  whether any exist.
- **Feature flags** for kill switches are `config` keys; paid or earned features are licence
  `flag` entitlements (`PolarisKey.license.is_entitled`); Godot feature tags are build facts, not
  remote flags.
- **Applying values** to the engine (vsync, audio buses, `Engine.max_fps`) is the game's job in a
  `config_changed` handler; `ProjectSettings.set_setting` at runtime does not re-apply most engine
  settings. `PKeyConfigBinding` covers plain node properties.
- **Web:** browser sessions get `secrets: {}`; Godot web builds use a device token, so secrets
  still arrive, and are readable by any same-origin script. Say so in the README.
- The GDScript mirror must parse on Godot 4.4 and be deterministic (sorted keys), like the other
  renderers.

## Steps

1. Port `resolveSource`, `resolveValue` and `listUserEntries`; port client-core's config tests.
2. Add the override-store interface and `PKeyConfigFileStore`; test enforced and hidden
   ignoring a saved value.
3. Add the environment and `--pkey-config` layers.
4. Add `get_secret`, `fetch_schema` and `mint_token` against the fake server.
5. Add `config_changed` (diffed after each sync) and `PKeyConfigBinding`.
6. Add the `gdscript` renderer and its tests; generate a sample from a fixture catalog and load
   it in the Godot runner.

## Acceptance criteria

- [ ] The ported config suite passes: enforced and hidden beat a saved local value and an env
      value; a `default` key follows local > env > remote default > fallback; `hidden` keys are
      absent from `list_user_config()`; `enforced` rows are flagged.
- [ ] `PKEY_CONFIG_dice__animSpeed=1.5` and `--pkey-config dice.animSpeed=1.5` both resolve
      `dice.animSpeed` to `1.5` with source `env` on a desktop debug run, and are ignored on a
      release web or mobile build unless enabled.
- [ ] A saved `settings.cfg` value for an `enforced` key stays in the file after a sync.
- [ ] `mint_token` returns the token and `expires_at`, serves the cached token on a second call
      before expiry, fetches again after it, maps 401 (after one re-acquire), 404, 429 and 500 to
      distinct kinds, and sends nothing when discovery says `config.mint.available` is false or
      the recipe id fails the pattern.
- [ ] `fetch_schema()` parses the catalog served by the fake server and returns `null` for a
      malformed body or a network failure.
- [ ] `mise exec node@22 -- pnpm --filter @polaris-key/tools test` covers the `gdscript`
      renderer (version, entries, defaults, escaping of quotes and non-ASCII labels), and the
      generated file loads in the Godot runner.
- [ ] `config_changed` fires once per sync with exactly the keys whose effective value changed.
- [ ] The green gate passes (`AGENTS.md`), including the `godot` CI job.
- [ ] `sdks/godot/parity.json` marks `config.resolve`, `config.list`, `config.secret`,
      `config.schema`, `config.mint`, `config.mirror` implemented, with test tags (once P1b-01
      has landed).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/tools test
mise exec node@22 -- pnpm typecheck
godot --headless --path sdks/godot -- --pkey-test config
GODOT_BIN=godot-4.7.2 GODOT_TEMPLATE=linux_release.x86_64 sdks/godot/tools/run_tests.sh
```

## Hand-off

- `PolarisKey.config` as above; `PKeyOverrideStore`, `PKeyConfigFileStore`, `PKeyConfigEntry`,
  `PKeyMintResult`, `PKeyConfigBinding`; the `config_changed(keys)` signal.
- The catalog (fetched or compiled) is what P1-10's `PKeySettingsPanel` renders from:
  `category`, `ui.widget`, `ui.order`, `ui.optionLabels`, `ui.advanced`, `dependsOn`.
- The edge-mint request, response and error mapping is the reference P1b-08 ports.
- `gen-mirrors --lang gdscript` is available to [D-02](D-02-diceroll-after-p1.md) if Diceroll
  wants compiled defaults; today it must be run from a checkout of this repo.
- Set the status with
  `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set P1-04 done`.
