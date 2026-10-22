# SP-61 Spring Boot starter on Spring Security

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Phase       | SP: SDK parity pass (notes/SDK-PARITY-PASS.md) (framework drop-ins (2026-10-08)) |
| Size        | 0.8–1.1 engineer-weeks                                                           |
| Depends on  | [SP-57](SP-57-kotlin-server-drop-ins-ktor.md)                                    |
| Unblocks    | none                                                                             |
| Role        | `pkey-sdk-porter`                                                                |
| Plan mode   | no                                                                               |
| Gates       | `ci:kotlin`                                                                      |
| Human input | none                                                                             |
| Repo        | `vladzaharia/polaris-key`                                                        |

## Goal

Spring Boot starter on Spring Security, as the [framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md) §12.1 scopes it. Done when every acceptance criterion holds and the green gate passes.

## Why

The owner asked for drop-ins that gate a server route or a CLI command with the app's signed licence document, verified offline ([plan](../../../2026-10-08-framework-drop-ins/README.md) §1, §4). The owner approved the plan and decided its eleven questions on 2026-10-08. This is its package SP-61 (optional).

## Read first

- `AGENTS.md` (always).
- [The framework drop-ins plan](../../../2026-10-08-framework-drop-ins/README.md): §1, §4, §5–§7 and §9 as they bear on this package, and §12.1 (row SP-61).

## Scope

**In:** `im.plrs.key:polaris-key-spring-boot-starter` over Spring Security, with `AuthenticationEntryPoint` and `AccessDeniedHandler` as the `errors = throw` default, on `polaris-key-server`.

**Out** (and where it belongs instead):

- Pages and parts other framework packages own (§12.1); anything the plan gives an existing package (§12.2).

## Design notes

- No new copies (tracks.md rule 4): build on the one mechanism the plan names, never beside it.

## Steps

1. Verify this brief against the code (the code is the fact) and record any correction here, in the same branch.
2. Implement the scope; run the green gate; hand off.

### Corrections (SP-61)

- The module is `:spring-boot-starter` (`polaris-key-spring-boot-starter`), package `im.plrs.key.server.spring`, on Spring Boot 3.5 / Spring Security 6.5, over `:server`.
- Feed publication plumbing (`.pkey/release.yaml`, `publish-sdks.yml`, the worker ingest golden) is not wired: the module has a `maven-publish` publication like `:server-ktor`, but the release lists are the lead's to extend when it ships.
- The integration content pipeline (`usage.ts`, `fit.ts`, goldens) is untouched: Spring is documented on `build/servers/spring` and in `server-kotlin.mdx` only.

## Acceptance criteria

- [x] A gated Spring MVC route answers each §5.2 verdict through Spring Security.
- [x] The green gate passes (`AGENTS.md`), including every drift gate in the header (scoped: see the hand-off report; `gen settings` / `gen docs-reference` are stale at staging independent of this package).

## Verify

Each acceptance item's test in its lane, then the full green gate in `AGENTS.md`.

## Hand-off

The role agent sets `--set SP-61 in-review` when it hands off. After review, the lead adds the last commit of the PR:
`node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set SP-61 done`.
