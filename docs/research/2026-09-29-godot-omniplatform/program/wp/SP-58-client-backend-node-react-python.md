# SP-58 The client half: `client.backend` in Node, React and Python

| Field       | Value                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                     |
| Size        | 1–1.4 engineer-weeks                                                                                                                                 |
| Depends on  | [SP-53](SP-53-backend-credential-contract.md), [SP-31](SP-31-node-bridge-v4.md)                                                                      |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-59](SP-59-client-backend-swift-kotlin-godot.md), [SP-65](SP-65-end-to-end-ci-client-backend-pkey-dev.md) |
| Role        | `pkey-sdk-porter`                                                                                                                                    |
| Plan mode   | no                                                                                                                                                   |
| Gates       | `all-sdks`, `drift-gate`                                                                                                                             |
| Human input | none                                                                                                                                                 |
| Repo        | `vladzaharia/polaris-key`                                                                                                                            |

## Plan follow-through (2026-10-09)

Approved [`plans/SP-53.md`](../plans/SP-53.md) and [`plans/SP-54.md`](../plans/SP-54.md) (2026-10-09) bear on this package; where they differ from the text below, they win.

- **Corrections.** The privacy file is `docs/PRIVACY.md`; there are eight locales, not nine; the `client` section of `backend-matrix.json` is SP-53's and is replayed here, not regenerated. `tools/gen-sdk-constants.test.ts` pins the `sdkId` list.
- **Sign-in refresh.** A client that signs in must refresh the licence document afterwards, because `profile.user` appears only once the device refreshes (SP-54 rollout step 4). I-10 already does this for the kit; `client.backend` must not send a document minted before the sign-in to a route that requires one.
- **Sequencing.** SP-53 merges first, SP-54 rebases and runs the one batched `pnpm gen corpus` after UK-03; this package starts on the integrated tree and regenerates nothing.

## Goal

The client half: `client.backend` in Node, React and Python, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-58.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-58).

## Scope

**In:** `client.backend` per §6: Node `fetch()`/`headers()`; React `usePolarisFetch()` (same origin allowed by default; through SP-31's bridge in Electron, where this package adds `backendHeaders()` to bridge v4); Python `httpx_auth()`/`requests_auth()`/`headers()`. `backend.origins` (exact, HTTPS only except loopback) from the client options and `polaris-key.json`; the `backend-origin-not-allowed` client code; the freshness pre-sync (`REFRESH_MARGIN_SECONDS`), shared concurrent sync, one retry on `license_stale`/`license_invalid`, and typed `not_entitled`/`sign_in_required` errors with their copy keys. Replays `backend-matrix.json` `client`.

**Out** (and where it belongs instead):

- Swift, Kotlin and Godot client halves (→ SP-59).

## Design notes

- The developer's own `Authorization` header passes through untouched.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Corrections found against the code (2026-10-16)

- `backend-origin-not-allowed` was in no registry. Added to `conformance/parity/errors.json`
  (kind `client`) and to all eight `copy.<locale>.json`; `pnpm gen constants brand` carried it to
  every SDK. No corpus row: the `client` section pins the retry rule, not the origin list.
- `polaris-key.json`'s `backend.origins` is SP-32a's (it owns that schema). Here the origins come
  from the client options only: Node `backend: {origins}`, Python `backend={"origins": [...]}`,
  React `config.backend.origins` and `usePolarisFetch({origins})`.
- React: a cookie-session page holds no signed licence document (the Worker answers it plain
  JSON), so `core.backend` is bearer-mode only on the web (`BEARER_ONLY`, `supports()` says
  `runtime` with the reason in `detail`). No registry change: it follows `identity.devicecode`.
- React redirects: `usePolarisFetch()` sets `redirect: "error"` unless the caller passes one,
  because a browser hides an opaque redirect's target.
- Python httpx: an `httpx.Auth` runs once per request and httpx follows redirects inside it, so
  a followed redirect to another origin cannot be stopped before it is sent (the response is
  refused afterwards). `follow_redirects` stays off by default; `requests` is checked per hop.
- Bridge v4 gains the invoke verb `core.backendHeaders` (`DEFAULT_INVOKE_VERBS`), answered by
  `client.backend.headers()`. In the renderer, a forced refresh is `bridge.refresh()` then the verb.

## Acceptance criteria

- [x] `client.backend` sends `X-PKey-License` and `X-PKey-Device`, never the token or the config document.
- [x] A non-allowed origin is refused with `backend-origin-not-allowed`.
- [x] `license_stale`/`license_invalid` force-sync and retry once; `not_entitled`/`sign_in_required` never retry.
- [x] The `client` section replays green in Node, React and Python.
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-58 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-58 done`.
