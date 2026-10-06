# SP-13 React device-local overrides (`config.local`): `config.set`, `config.setting` and `onConfigChange`, persisted in the browser and forwarded to the host on the desktop bridge

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps) |
| Size        | 0.4–0.6 engineer-weeks                                    |
| Depends on  | none                                                      |
| Unblocks    | none                                                      |
| Role        | `pkey-sdk-porter`                                         |
| Plan mode   | no                                                        |
| Gates       | unit tests; `parity:check`; the generated parity page     |
| Human input | none                                                      |
| Repo        | `vladzaharia/polaris-key`                                 |

## Goal

A React app persists device-local config overrides with S-17's names (`config.set(key, value)`, `config.clear(key)`, `config.clearAll()`, `config.setting(key)`, `onConfigChange(key, listener)`), validated against the catalog type and refused for an admin-managed key, and `useConfigSetting(key)` re-renders on change.

## Why

React shows only delivered values (`ConfigPanel`); Node, Python and Swift persist overrides already. The registry pins S-17's names so U-06 and U-20 can add sync state under the same API. The parity rows it owns: `config.local` in `packages/sdk-react/parity.json`; their `note` fields give the current state. It absorbs the parity note's the `config.local` half of SP-R04 and SP-R05 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `notes/SDK-PARITY-PASS.md` §3.11; `notes/S-17` §5.11 (the names).
- Node's `client.config.set/clear/setting/onConfigChange` in `packages/sdk-node/src/config/` as the reference.
- `packages/sdk-react/src/` config hooks and `ConfigPanel`.

## Scope

**In:**

- A browser store (localStorage, every access in try/catch, a memory fallback surfaced as not-persistent) keyed per product.
- Catalog type validation and the admin-managed refusal, as in Node.
- `desktop-bridge`: forward to the host's `client.config` local API; a v3 host without the verb answers typed `unsupported`.
- `useConfigSetting(key)` and a `ConfigPanel` edit affordance for overridable keys.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Cloud Sync of overrides (→ phase U, U-06/U-20).

## Design notes

- **Bridge host.** A new `invoke` verb this package adds to the React desktop adapter needs its host handler too. If [SP-31](SP-31-node-bridge-v4.md) (the Node host on bridge v4) has landed, add the handler in `packages/sdk-node/src/electron/main.ts` and `DEFAULT_INVOKE_VERBS` with a round-trip test, and add the verb to `bridge.ts`'s "WHAT v4 ADDS", in the same PR. If SP-31 has not landed, SP-31 picks the verb up from `main`.
- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- Device-local only. The unit proof persists, clears, validates against the catalog type and emits change events (registry note).

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [x] `@pkey-feature config.local` unit tests: persist and reload, clear and clearAll, a type mismatch refused, an admin-managed key refused, a change event per write, and the bridge forwarding path.
- [x] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [x] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [x] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- U-06 and U-20 extend this API with sync state.

The role agent sets `--set SP-13 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-13 done`.
