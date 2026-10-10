# UK-22 Host design systems: Tailwind v4 preset, shadcn/ui registry at `key.plrs.im/r/<name>.json` over the React hooks, MUI/Mantine/Chakra theme objects, "go native" recipes

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (should)                 |
| Size        | 1.5–2 engineer-weeks                                                                           |
| Depends on  | none                                                                                           |
| Unblocks    | none                                                                                           |
| Role        | `pkey-implementer`                                                                             |
| Plan mode   | no                                                                                             |
| Gates       | `gen brand --check` for the generated presets; rule 10 for the registry route; docs link check |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Consolidation 2026-10-07

> **Closed 2026-10-07 (DX consolidation): split into [UK-04](UK-04-web-components.md) and [UK-31](UK-31-web-recipes.md).** The id stays in the graph as `dropped` so it
> is not reused; do not build this package. Its scope moves to [UK-04](UK-04-web-components.md) and [UK-31](UK-31-web-recipes.md).

The [DX consolidation plan](../../../2026-10-07-dx-consolidation/README.md) records this package as **split** in [`backlog-changes.json`](../../../2026-10-07-dx-consolidation/backlog-changes.json); the [decision record](../../../2026-10-07-dx-consolidation/integration.md) has the reasoning. This section wins over the text below where they differ.

> Tailwind v4 preset to UK-04, the CSS-variable 'bring your own design system' recipe to UK-31; the shadcn registry route and the MUI, Mantine and Chakra theme objects are parked.

- Dependencies cleared on closing (they were UK-01, UK-05 and UK-16), so nothing in the graph waits on or through a closed package.

## Goal

A team on Tailwind, shadcn/ui, MUI, Mantine or Chakra gets Polaris Key screens in its own design system without a new kit.

## Why

§3.5: no new kits for host design systems; presets and a registry instead. The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §3.5
- `packages/brand/css/theme.css`, `packages/sdk-react` hooks

## Scope

**In:**

- Tailwind v4 preset and MUI/Mantine/Chakra theme objects generated from the tokens.
- A shadcn/ui registry whose components use the React headless hooks, served by the Worker at `key.plrs.im/r/<name>.json` (with OpenAPI entry).
- "Go native" recipes per platform in the docs `build/ui/` Recipes page.

**Out** (and where it belongs instead):

- New styled kits (none).

## Design notes

- None beyond the spec.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] `npx shadcn add https://key.plrs.im/r/activate.json` installs a working Activate component in a fresh Next.js app (recorded in the PR).
- [ ] The generated presets are covered by `gen brand --check`.
- [ ] The §7.3 lint passes on the registry components' default render.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
mise exec node@22 -- pnpm gen brand --check
mise exec node@22 -- pnpm --filter @polaris-key/worker test
```

## Hand-off

None.

The role agent sets `--set UK-22 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-22 done`.
