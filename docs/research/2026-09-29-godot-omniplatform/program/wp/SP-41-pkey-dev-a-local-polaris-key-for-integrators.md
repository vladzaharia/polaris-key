# SP-41 `pkey dev`: a local Polaris Key for integrators

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (SDK usability review (2026-10-08))                                                                         |
| Size        | 1.5–2.2 engineer-weeks                                                                                                                                     |
| Depends on  | none                                                                                                                                                       |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [SP-36](SP-36-examples-in-one-tree-built-in-ci.md), [SP-42](SP-42-test-doubles-on-the-real-client-in-every-sdk.md) |
| Role        | `pkey-implementer`                                                                                                                                         |
| Plan mode   | no                                                                                                                                                         |
| Gates       | `ci`, `cli-bundle`, `docs-links`                                                                                                                           |
| Human input | none                                                                                                                                                       |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                  |

## Goal

`pkey dev`: a local Polaris Key for integrators, as the [SDK usability review](../../../2026-10-08-sdk-usability/README.md) §10.2 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

Eighteen hands-on trials across Node, React, Python, Swift, Kotlin and Godot (the drop-in kit, your own UI, and a newcomer) averaged 5.3/10. This package fixes what they found; the evidence is in [`findings.json`](../../../2026-10-08-sdk-usability/findings.json) and the review's §5 and §7.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [The SDK usability review](../../../2026-10-08-sdk-usability/README.md): §1, §5, the SDK's part of §7, §10.2 (SP-41) and §10.4.

## Scope

**In:** `pkey dev` in `@polaris-key/cli` runs the real Worker router in-process on Node ≥22.13's built-in SQLite with in-memory KV and Durable Object mocks: no wrangler, no Cloudflare account, no secrets, no migrations step. It seeds from the repo's `.pkey/` or the built-in Tidewater product (which SP-36 then reuses), with throwaway signing and release keys; test keys for ok, expired, disabled, revoked, device-limit-full, key-entry-limit and floating; a fake IdP approval page; a signed release on stable and beta; `web.origins` for localhost; control commands (expire, disable, revoke, fill seats, set a config value, publish a release, go offline). It writes `polaris-key.json` (until SP-32b, `pkey sdk --dev` writes today's per-SDK config) and prints the pins. Loopback only. Every SDK namespaces its store by host for a non-default base URL, so a dev run never touches production state on the same machine (production names unchanged). Also published as an OCI image for developers without Node. A "Run Polaris Key locally" page (emulator and simulator notes such as `adb reverse`) is linked from step 1 of every quickstart.

**Out** (and where it belongs instead):

- The 0.9 rebuilds and renames (→ SP-35, SP-35b and the UK kit packages); anything §10.1 gives an existing package.

## Design notes

- The real Worker router, in-process, not a transcript replay: refusals must match production, and replay would need state for revoke and config changes (§10.4). SP-36 runs its examples on it.
- Only non-default hosts are namespaced; production names are unchanged and nothing is orphaned (§10.4).

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] Starts in under 10 s from a clean machine with no account.
- [ ] In CI, each SDK's quickstart reaches first activation, every refusal kind exactly as the deployed Worker answers it, a config change event, device-code sign-in and an update decision.
- [ ] It never contacts `key.plrs.im` (test).
- [ ] The dev routes and fake IdP are absent from the production Worker bundle (build test).
- [ ] A dev run leaves production store entries untouched (Node and Python tests, parity rows for the rest).
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its SDK lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-41 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-41 done`.
