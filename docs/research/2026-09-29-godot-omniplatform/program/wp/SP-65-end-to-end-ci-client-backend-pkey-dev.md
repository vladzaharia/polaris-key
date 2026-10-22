# SP-65 End-to-end CI: client SDK → example backend → `pkey dev`

| Field       | Value                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                    |
| Size        | 0.6–0.9 engineer-weeks                                                                                                                                                                                                                                              |
| Depends on  | [SP-41](SP-41-pkey-dev-a-local-polaris-key-for-integrators.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [SP-57](SP-57-kotlin-server-drop-ins-ktor.md), [SP-58](SP-58-client-backend-node-react-python.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-65b](SP-65b-e2e-react-native-require-sign-in.md)                                                                                                                                                                        |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                  |
| Plan mode   | no                                                                                                                                                                                                                                                                  |
| Gates       | `ci`                                                                                                                                                                                                                                                                |
| Human input | none                                                                                                                                                                                                                                                                |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                           |

## Goal

End-to-end CI: client SDK → example backend → `pkey dev`, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-65.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-65).

## Scope

**In:** A CI lane that runs a client SDK against an example backend against `pkey dev`: activate, a valid gated call, a stale document (refresh then succeed), a failed re-sync, a `not_entitled` call, and the client's own gate state, across the must-tier server frameworks.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] The end-to-end lane is green against `pkey dev` for every must-tier server framework.
- [x] A stale document triggers a refresh and then succeeds (test). (Express, Hono, FastAPI, Flask.)
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-65 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-65 done`.

## Progress and continuation (2026-10-17)

Built (branch `wp/SP-65-e2e-ci`): CI job `e2e-backend` (ci.yml) and lane `e2e-backend` in
tools/ci-scope.json (packages/server, sdk-node, cli, worker, sdks/python, examples/server-\*; the
shared inputs turn it on too). Each leg runs on its own fresh `pkey dev` through
`start-dev-ci.mjs` (loopback, no secrets, `pkey dev` is never in a deployed path).

- Node leg: `packages/server/test/e2e.live.test.ts`. Node client over `client.backend.fetch` to
  examples/server-express, server-hono and server-next (route handlers behind a socket). Cases:
  activate, valid gated call, no credential (`license_required` + challenge), `not_entitled`
  (typed, status 403), failed re-sync (`pkey dev offline`: the backend's `license_stale` comes
  back), stale document (refresh then success), gate state after each. Needs
  `@polaris-key/node` as a server devDependency (lockfile updated).
- Python leg: `sdks/python/tests/test_e2e_live.py`. Python client `backend.httpx_auth()` to FastAPI
  and Flask apps on `polaris_key.server`; same cases. `uvicorn` joined the `dev` extra.
- Local run: about 50 s for both legs after the build.

Corrections to the brief: staleness cannot come from `maxAgeSeconds` (a 300 s skew allowance is
added) or from real time (documents last hours), so the test moves the backend's `now`/`clock`
ahead and the test transport puts it back when the device reaches the Worker's `/license/`
routes. A client's forced sync is throttled to one per 10 s, so each client waits between the
failed re-sync and the stale case (about 20 s per leg). A key has three key entries and a
deactivation returns none, so one client per framework shares its cases.

Left (named slots, each a leg or a case in the same job):

1. React client (`usePolarisFetch`): needs a browser-CORS page harness against an example
   backend; devLive.test.tsx's `pageFetch` should be extracted rather than copied.
2. SP-59's Swift, Kotlin and Godot clients, and the JVM client against server-ktor / :server.
3. Django and DRF (the middleware reads Django settings, so the clock cannot be skewed: no stale
   case until the core takes a clock there) and Next's stale cases (`createNextPolarisKey` in the
   example takes no `now`).
4. `requireSignIn()` end to end, once SP-54 lands the signed-in subject.

Status stays `in-progress`.

## Split 2026-10-22 (triage)

Stays in progress for the must tier (Django/DRF with an injectable clock; the Next stale case). The React `usePolarisFetch`, native-client and `requireSignIn` legs are **[SP-65b](SP-65b-e2e-react-native-require-sign-in.md)**.
