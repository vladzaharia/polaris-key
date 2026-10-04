# F-21 Registry auth: tokens, the per-feed access-mode switch, console and portal token UI

| Field       | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Phase       | F: Package feeds (pkg.plrs.im) (tier-2)                                                                |
| Size        | 2–3 engineer-weeks                                                                                     |
| Depends on  | [F-20](F-20-registry-credentials-plan.md), [F-11](F-11-console-feeds.md)                               |
| Unblocks    | [F-22](F-22-native-publish.md), [F-23](F-23-docker-push.md)                                            |
| Role        | `pkey-implementer`                                                                                     |
| Plan mode   | no separate plan: executes the approved `plans/F-20.md`                                                |
| Gates       | D1 migration and `TABLE_OWNERS` (registry tokens); THREAT-MODEL; rule 10 (`/v2/token`, Swift `/login`) |
| Human input | none                                                                                                   |
| Repo        | `vladzaharia/polaris-key`                                                                              |

## Goal

Feeds can be switched to `authenticated`, `licensed` or `entitled` from their Settings, and
clients authenticate with `pkeyr_` tokens minted in the console or the portal, as `plans/F-20.md`
specifies. No route, renderer or stored document changes.

## Why

This is the "auth later" half of the owner's access decision ([S-12 §7](../../notes/S-12-package-feeds.md#7-access-public-now-auth-as-configuration)).

## Read first

- `plans/F-20.md`; [`plans/F-01.md`](../plans/F-01.md) §6.6.

## Scope

**In:**

- Tokens and their table.
- `feedPrincipal` token parsing.
- The access-mode switch enabled in F-11's Settings.
- Console and portal token pages.
- `/v2/token`, Swift `/login` and the Cargo flag.
- Snippets with credentials (F-12's renderer).

**Out:**

- Native publish (→ F-22, F-23).

## Design notes

- Non-public answers stay `private, no-store` and outside the Cache API.

## Steps

1. Follow `plans/F-20.md`'s step order.

## Acceptance criteria

- [ ] Each tier-1 client matrix also passes against an `authenticated` feed with a token.
- [ ] The green gate passes (`AGENTS.md`).

## Verify

```sh
mise exec node@22 -- pnpm --filter @polaris-key/worker test -- registry auth routeCoverage
```

## Hand-off

- F-22 and F-23 use `publish`-scoped tokens.

The role agent sets `--set F-21 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set F-21 done`.
