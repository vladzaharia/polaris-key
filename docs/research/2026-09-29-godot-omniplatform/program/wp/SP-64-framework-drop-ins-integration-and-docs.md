# SP-64 Framework drop-ins on the Integration page and in the docs (servers and CLIs)

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08))                                                                                                                                                                                                                                                                                                       |
| Size        | 1.2–1.6 engineer-weeks                                                                                                                                                                                                                                                                                                                                                                 |
| Depends on  | [SP-33a](SP-33a-one-integration-content-generator-on.md), [SP-55](SP-55-polaris-key-server-express-hono-next.md), [SP-56](SP-56-python-server-drop-ins.md), [UK-46](UK-46-node-terminal-kit-for-existing-clis.md), [UK-48](UK-48-python-terminal-kit-as-a-mountable-drop-in.md), [DOC-03a](DOC-03a-skeleton-and-contracts.md), [SP-54](SP-54-signed-in-subject-in-licence-document.md) |
| Unblocks    | [P0-51](P0-51-1-0-readiness-review.md), [AX-11](AX-11-drop-in-skills-servers-and-cli-hosts.md)                                                                                                                                                                                                                                                                                         |
| Role        | `pkey-implementer`                                                                                                                                                                                                                                                                                                                                                                     |
| Plan mode   | no                                                                                                                                                                                                                                                                                                                                                                                     |
| Gates       | `docs-generated`, `docs-links`, `console-csp-parity`                                                                                                                                                                                                                                                                                                                                   |
| Human input | none                                                                                                                                                                                                                                                                                                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                                                                                                                                                                                                                                                                                                              |

## Goal

Framework drop-ins on the Integration page and in the docs (servers and CLIs), as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-64.

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-64).

## Scope

**In:** §10: `sdkFit(platforms, repoSignals)` returns `{sdk, host, framework}` from the server and CLI repo signals; the server card (the framework snippet with the product's config and first entitlement, two links, Verified on a `<lang>-server` sighting), the app card's `client.backend` line, and the CLI card's mount and gate. Docs (public): the **Your server** third lane on Licensing, Sign-in, Managed config and Commerce with the host/framework picker; `build/servers/` and one page per framework; the CLI framework sections under the kit pages; the four `backend` codes on the error reference. Snippets come from SP-33a's generator with `lane: "server"`.

**Out** (and where it belongs instead):

- The concepts page `features/licensing/server-verification` (→ DOC-09a); the generator itself (→ SP-33a).

## Design notes

- The docs are public (owner, 2026-10-08).
- The managed-config server lane is written on the plain client; `serverClient()` (SP-63, optional) is a later improvement.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

## Acceptance criteria

- [ ] `sdkFit` detects each must-tier framework from its repo signal; the server card turns Verified on a `<lang>-server` sighting.
- [ ] The Your server lane renders for Licensing, Sign-in and Managed config; lanes stay the only tab set (docs plan §3.6).
- [ ] Every server snippet compiles as an SP-33a golden.
- [ ] `build/servers/` states the one-hour replay window and the ~65-minute revocation bound.
- [ ] The green gate passes (`AGENTS.md`), including every drift gate in the header.

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-64 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-64 done`.
