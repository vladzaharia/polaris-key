# SP-31 Electron bridge v4: first slice of the Electron kit

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                                                                                      |
| Size        | 0.75–1.25 engineer-weeks                                                                                                                                       |
| Depends on  | [SP-12](SP-12-react-boot-download.md)                                                                                                                          |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [U-20](U-20-sdk-settings-react.md), [SP-58](SP-58-client-backend-node-react-python.md), [UK-06](UK-06-electron-kit.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                              |
| Plan mode   | no                                                                                                                                                             |
| Gates       | `packages/sdk-node` and `packages/sdk-react` suites; `parity:check`; the generated parity page                                                                 |
| Human input | none                                                                                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                      |

## Consolidation 2026-10-07

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **edit** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json) ([Track J, SDK and UI-kit consolidation](../../../2026-10-07-dx-consolidation/tracks.md#j-sdk-and-ui-kit-consolidation)); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> The first slice of the Electron kit inside @polaris-key/node/electron (exposePolarisBridge keeps its name, bridge v4); no separate @polaris-key/electron package (C-43). UK-06 builds on it; U-20 needs it.

- Title: was "Node Electron host speaks PolarisBridge v4: `exposePolarisBridge` reports version 4 and answers every v4 `invoke` verb, sign-in field and activation kind over the Node client; `bridge.ts` documents the v4 contract".

## Framework drop-ins (2026-10-08)

The [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.2 changes this package. Where it differs from the text below, it wins.

- SP-58 adds `backendHeaders()` to the bridge, so `usePolarisFetch()` works in Electron.

## Goal

`@polaris-key/node/electron`'s `exposePolarisBridge` speaks PolarisBridge v4: `subscribe` answers
`{ version: 4 }`, and every verb the React desktop adapter sends to a v4 host is answered over the
Node client instead of being refused typed. A renderer driving `DesktopAdapter` against a real
Node host can boot, fetch a licensed build, read the download model, ask for a feed URL, read crash
tags, mint a config token, run commerce and read discovery, the device id and the store status.
The v4 contract is written down once, in `packages/sdk-react/src/desktop/bridge.ts`'s
"WHAT v4 ADDS" block, which no longer says the host is pending.

## Why

The renderer half of bridge v4 shipped with SP-R07 and SP-12, but the host half did not. The
host is the SP-N10 work that already landed as v3 (`packages/sdk-node/src/electron/`), and no
package owns its move to v4. So `protocol.ts` still exports `POLARIS_BRIDGE_VERSION = 3` and a
`DEFAULT_INVOKE_VERBS` list of v3 verbs, and the adapter's `speaksV4()` gate refuses every v4 verb
on an Electron app built on our own SDK. `bridge.ts` says so in its own comment ("the host side is
pending SP-N10"). The parity note treats bridge v4 as a contract implemented on both sides
([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5 SP-R07, §6 "Not wire, but contracts").
This package closes that gap. No other package covers it: there is no SP-N10 package in the graph,
because the v3 host landed before the SDK-gap packages were filed.

## Read first

- `AGENTS.md` and `CLAUDE.md`.
- `notes/SDK-PARITY-PASS.md` §2.1, §5 (SP-N10, SP-R07, SP-R08, SP-R09) and §6.
- The renderer side, which is the contract: `packages/sdk-react/src/desktop/bridge.ts` (types,
  `BRIDGE_VERSION`, `BRIDGE_VERSIONS_ACCEPTED`, "WHAT v4 ADDS") and
  `packages/sdk-react/src/desktop/desktopAdapter.ts` (every `this.bridge.invoke(service, method, args)`
  call and the value shape it expects back; `speaksV4()`).
- The host: `packages/sdk-node/src/electron/protocol.ts`, `main.ts` (`invokeVerbs`,
  `bridgeActivation`, `beginSignIn`/`pollSignIn`), `preload.ts`, `renderer.ts`, and
  `packages/sdk-node/test/electronBridge.test.ts`.
- The Node client methods the verbs forward to: `client.boot()`, `client.crashTags()`,
  `client.release.fetch()`, `client.distribution.*`, `client.update.feedUrl()`,
  `client.config.mintToken()`, `client.commerce.binding()`/`claim()`, `client.identity.*`,
  `client.license.activateWithKey()` in `packages/sdk-node/src/`.

## Scope

**In:**

- `POLARIS_BRIDGE_VERSION = 4` and `DEFAULT_INVOKE_VERBS` widened to every v4 verb, each with a
  handler in `main.ts`:
  - from SP-R07: `config.mint` (`{recipeId}` → `{token, expiresAt}`), `commerce.binding`
    (→ `{bindingId, products}`), `commerce.claim` (`{store, payload}` → `CommerceClaimResult`, then
    a state push), `core.discovery`, `core.storeStatus`, `devices.id`;
  - from SP-12: `core.boot` (opts → the host's `BootOutcome`, then a state push), `core.crashTags`,
    `release.fetch` (`{target, to}` → `{path, size, sha256, version, buildId}`),
    `distribution.downloadModel` (`{channel}`), `distribution.thisPlatform` (`{channel, platform}`),
    `update.feedUrl` (`{kind, ...opts}`).
- The v4 shapes on the existing methods: `beginSignIn({deviceName?})` (the renderer's name wins
  over the host option, which stays the default), the begin result's `verificationUri`, `expiresAt`
  and `interval`; `pollSignIn`'s `ok` carrying `identity`; `bridgeActivation` returning
  `fingerprint-required`, `enroll-disabled`, `hardware-mismatch{drift, changed}` and
  `refused{code, status, message}` instead of folding them into `error`.
- Any further v4 verb that has merged on the renderer side when this package starts. SP-13
  (`config.local`: `config.set`, `config.setting`, the change forwarding), SP-14 (telemetry
  forwarding into the host's journal), SP-15 (`update.install` and the boot guard) and SP-16
  (commerce in bearer mode) may each add one. Whatever is on `main` at the start is in scope;
  whatever lands later is that package's to add on the host (see Hand-off).
- `bridge.ts`'s "WHAT v4 ADDS" block rewritten as the full v4 contract: every method change and
  every `invoke` verb with its args and result shape, the `unsupported{reason: "version"}` rule
  for v3 hosts, and the host it is implemented by. Drop the "pending SP-N10" wording. The
  file-header comments in `protocol.ts` and `main.ts` say v4.
- `packages/sdk-node/parity.json` and `packages/sdk-react/parity.json` notes that mention the v3
  host or SP-N10 as pending are rewritten. Regenerate the parity page.

**Out** (and where it belongs instead):

- Pack verbs and the `onPackProgress` push. They stay reserved in `bridge.ts` for a later revision,
  until a React pack client exists.
- New Node client capabilities. Every verb forwards to a method that already exists. A missing
  one is a stop-and-report, not something to build here.
- The verbs SP-13 to SP-16 add after this package starts (→ those packages).

## Design notes

- **No wire change.** The bridge is an in-process contract between `sdk-react` and `sdk-node`
  (§6), not server wire, so this is not plan mode. Do not touch `shared-protocol`, the corpus or
  `PROTOCOL_VERSION`.
- **Version negotiation stays as it is.** The renderer accepts v3 and v4
  (`BRIDGE_VERSIONS_ACCEPTED`). A v4 host must keep answering every v3 verb unchanged, so an older
  renderer works against it.
- **`release.fetch`'s `to` is a path in the privileged process.** A renderer must not be able to
  write anywhere the main process can. The host resolves `to` inside a download directory it owns:
  add an `exposePolarisBridge` option, `downloadDir`, defaulting to Electron's
  `app.getPath("downloads")` passed in by the caller. Refuse an absolute path or a `..` escape
  with a typed `invalid-argument`, and return the resolved `path`. Record the rule in
  `docs/security/THREAT-MODEL.md`'s Electron bridge entry.
- **Envelopes, not rejections.** Every handler resolves a `BridgeEnvelope`. Errors keep their
  `code` and, for update refusals, their `detail`, because the adapter maps them by `code`.
- **State pushes** follow every verb that changes state: `core.boot`, `commerce.claim`,
  `release.fetch` if it updates the cache, and sign-in `ok`.
- **The allowlist stays an allowlist.** Widening `DEFAULT_INVOKE_VERBS` is the only way a verb
  becomes callable. `invoke.extra` keeps working for host-specific verbs.

## Steps

1. Diff the adapter's v4 calls against `invokeVerbs`, and list each verb with its args and expected
   result.
2. Extend `electronBridge.test.ts` first. Run a round trip per verb through a fake `ipcMain` and
   the real preload unwrapping, typed against `sdk-react`'s `bridge.ts`, plus the `to` path
   refusals and the v4 activation kinds.
3. Implement the handlers and bump the version.
4. Add a test in `packages/sdk-react` that drives `DesktopAdapter` against the Node host's
   handlers in-process, so a v4 verb that crosses the bridge is no longer refused typed.
5. Rewrite "WHAT v4 ADDS", the header comments and the parity notes, then regenerate the parity
   page.

## Acceptance criteria

- [ ] `POLARIS_BRIDGE_VERSION` is 4, and `subscribe` answers `{ version: 4 }`.
- [ ] `DEFAULT_INVOKE_VERBS` contains every `invoke(service, method)` pair that
      `desktopAdapter.ts` sends on `main` at the start of this package. A test enumerates the
      adapter's calls (or a shared list) and fails on a pair with no host handler.
- [ ] Each v4 verb has a round-trip test in `electronBridge.test.ts` that checks the result shape
      `bridge.ts` declares.
- [ ] `release.fetch` refuses an absolute or escaping `to` with `invalid-argument` and writes
      only under `downloadDir` (tests). The threat model records the rule.
- [ ] `submitKey` returns `fingerprint-required`, `enroll-disabled`, `hardware-mismatch` and
      `refused{code}` (tests). `beginSignIn` passes the renderer's `deviceName` and returns
      `verificationUri`, `expiresAt` and `interval`. `pollSignIn`'s `ok` carries `identity`.
- [ ] Every v3 method and verb answers exactly as before (the existing tests pass unchanged).
- [ ] `bridge.ts`'s "WHAT v4 ADDS" lists every v4 change with args and result shapes and no
      longer calls the host pending. `protocol.ts` and `main.ts` say v4.
- [ ] `mise exec node@22 -- pnpm parity:check` passes and the generated parity page is current.
- [ ] The green gate passes (`AGENTS.md`), scoped to `sdk-node`, `sdk-react` and docs.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/node test electronBridge
mise exec node@22 -- pnpm --filter @polaris-key/react test desktop
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- After this lands, the Node host is the reference v4 host. SP-13, SP-14, SP-15 and SP-16 each add
  the host handler for any bridge verb they introduce, in `packages/sdk-node/src/electron/main.ts`
  and `DEFAULT_INVOKE_VERBS`, and extend "WHAT v4 ADDS" in the same PR. Each of those briefs carries this
  as a design note.
- Pack verbs stay reserved for a later bridge revision.

The role agent sets `--set SP-31 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-31 done`.
