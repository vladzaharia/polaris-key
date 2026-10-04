# CLAUDE.md

**Read `AGENTS.md` first — it is canonical.** Repo map, the Node 22 constraint, the full green
gate, and the eleven hard rules all live there. This file adds only what is specific to Claude
Code.

## Skills

Three project skills are installed under `.claude/skills/`. Invoke the matching one instead of
improvising:

- **`authoring-pkey-manifests`** — creating or editing a product's `.pkey/product`, `.pkey/schema`
  or `.pkey/release`, and registering or resyncing that product.
- **`adding-a-catalog-entry`** — adding a `config`, `secret` or `flag` key to a product's config
  catalog and publishing it.
- **`running-the-omniplatform-program`** — leading the Godot-on-Polaris-Key execution program in
  `docs/research/2026-09-29-godot-omniplatform/program/`: choosing ready work packages and
  dispatching the `pkey-*` role agents in `.claude/agents/`.

## Running commands

Prefix every JS/TS command with the pinned Node: `mise exec node@22 -- pnpm <cmd>`. On a newer
Node major, `better-sqlite3` fails to build and the entire worker package fails to _collect_ —
the failure will not look like the change you made.

## Waiting on long jobs

Minimise idle time. Sleep as little as reasonable:

- Prefer a background job that notifies on exit (`run_in_background`) over `sleep` + poll loops.
- When polling is unavoidable, use short intervals matched to the job (seconds, not minutes) and
  check the actual completion signal (exit status, a log's final line).
- Never sleep "just in case". While a gate or build runs, do other independent work in the task
  instead of waiting.

## Plan mode

Enter plan mode before any wire-touching change — `shared-protocol`, `shared-jws`, `client-core`,
a signed document shape, `PROTOCOL_VERSION`, or the conformance corpus. Such a change is an
all-languages event (contract → catalog → corpus → SDKs) and the plan must name the corpus
regeneration and every SDK that has to follow. Adding a validator rule, a route, or a generated
docs page also has a drift gate attached (`AGENTS.md` rules 3, 9–10) — say which one you will run.
