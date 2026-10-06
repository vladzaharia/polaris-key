# SP-16 React commerce in bearer mode (`commerce.receipt`): the commerce binding and claim routes in the Worker's `CORS_SERVICE_PATHS`, and React's cross-origin replay of P6-01's transcript

| Field       | Value                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK gaps)                                               |
| Size        | 0.2–0.4 engineer-weeks                                                                                  |
| Depends on  | none                                                                                                    |
| Unblocks    | none                                                                                                    |
| Role        | `pkey-sdk-porter`                                                                                       |
| Plan mode   | no                                                                                                      |
| Gates       | `test:workerd` (CORS); a THREAT-MODEL row; transcript replay; `parity:check`; the generated parity page |
| Human input | none                                                                                                    |
| Repo        | `vladzaharia/polaris-key`                                                                               |

## Goal

A cross-origin React page in bearer mode can call `GET /<p>/distribution/commerce/binding` and `POST /<p>/distribution/commerce/claim`: both are in `CORS_SERVICE_PATHS` under the product's `web.origins`, and React's commerce row is `implemented` on `web` and `desktop-bridge`.

## Why

The bearer engine already speaks both routes and the desktop adapter already invokes the host's `client.commerce` (Node implements it), but the Worker's CORS allow-list does not cover them, so a cross-origin page is refused. LX-20 owned React's row; this package takes it, and LX-20 keeps Swift, Kotlin and Node. The parity rows it owns: `commerce.receipt` in `packages/sdk-react/parity.json`; their `note` fields give the current state. It absorbs the parity note's SP-R10 ([`SDK-PARITY-PASS.md`](../../notes/SDK-PARITY-PASS.md) §5). Filed on 2026-10-05 from the rows still `planned` after `fix/sdk-parity-followups`; ids continue from SP-12 as [`plans/SP-00.md`](../plans/SP-00.md) D8 sets.

## Read first

- `AGENTS.md` and `CLAUDE.md`; `PARITY.md` and `conformance/parity/features.json` for each row's proof.
- `packages/worker/src/core/cors.ts` (`CORS_SERVICE_PATHS`) and its tests.
- `packages/sdk-react/src/browser/bearer/session.ts` and `packages/sdk-react/src/desktop/desktopAdapter.ts` (`commerceBinding`, `commerceClaim`).
- `docs/security/THREAT-MODEL.md` (the CORS rows); `wp/LX-20-commerce-clients.md`; P6-01's transcript.

## Scope

**In:**

- `distribution/commerce/binding` and `distribution/commerce/claim` added to `CORS_SERVICE_PATHS`, with a workerd test of the preflight and the allowed origin.
- A THREAT-MODEL row: the claim needs the device bearer, so CORS widens reach only to the product's own origins.
- React tests replaying P6-01's commerce transcript on both runtimes.
- The manifest rows above flipped, with notes saying what was built.

**Out** (and where it belongs instead):

- Store purchase UI and restore (→ UK-\* kits, LX-20 for the native SDKs).

## Design notes

- No wire change: every route, transcript and corpus file this package needs already exists. If one
  turns out to be missing, stop and report; it becomes a plan-mode package.
- No route or response shape changes, so no OpenAPI edit; `routeCoverage` is unchanged.

## Steps

1. Read the rows' notes and the reference implementation.
2. Write the `@pkey-feature` tests first, against the transcript, corpus or vectors named below.
3. Build until they pass, then flip the rows and regenerate the parity page.

## Acceptance criteria

- [ ] A workerd test proves the preflight and the response headers for an allowed origin and their absence for another.
- [ ] `@pkey-feature commerce.receipt` tests in `packages/sdk-react` replay the commerce transcript in bearer mode and through the bridge.
- [ ] Every row this package owns reads `implemented` in its manifest, with `wp` and `unowned` removed and the note rewritten to say what was built (or a typed `except` where the registry allows an N/A for one runtime).
- [ ] `mise exec node@22 -- pnpm parity:check` passes, and the generated parity page is current (`pnpm --filter @polaris-key/docs gen -- --check`).
- [ ] The green gate passes (`AGENTS.md`), scoped to the SDKs this package touches.

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react test
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test:workerd
mise exec node@22 -- pnpm parity:check
mise exec node@22 -- pnpm --filter @polaris-key/docs gen -- --check
```

## Hand-off

- LX-20 no longer owns React's row.

The role agent sets `--set SP-16 in-review` when it hands off. After review, the lead adds the last
commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-16 done`.
