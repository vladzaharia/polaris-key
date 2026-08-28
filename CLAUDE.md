# CLAUDE.md

**Read `AGENTS.md` first — it is canonical.** Repo map, the Node 22 constraint, the full green
gate, and the eleven hard rules all live there. This file adds only what is specific to Claude
Code.

## Skills

Two project skills are installed under `.claude/skills/`. Invoke the matching one instead of
improvising:

- **`authoring-pkey-manifests`** — creating or editing a product's `.pkey/product`, `.pkey/schema`
  or `.pkey/release`, and registering or resyncing that product.
- **`adding-a-catalog-entry`** — adding a `config`, `secret` or `flag` key to a product's config
  catalog and publishing it.

## Running commands

Prefix every JS/TS command with the pinned Node: `mise exec node@22 -- pnpm <cmd>`. On a newer
Node major, `better-sqlite3` fails to build and the entire worker package fails to _collect_ —
the failure will not look like the change you made.

## Plan mode

Enter plan mode before any wire-touching change — `shared-protocol`, `shared-jws`, `client-core`,
a signed document shape, `PROTOCOL_VERSION`, or the conformance corpus. Such a change is an
all-languages event (contract → catalog → corpus → SDKs) and the plan must name the corpus
regeneration and every SDK that has to follow. Adding a validator rule, a route, or a docs page
also has a drift gate attached (`AGENTS.md` rules 9–11) — say which one you will run.
