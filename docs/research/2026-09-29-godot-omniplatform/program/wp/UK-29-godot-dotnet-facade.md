# UK-29 Godot .NET (C#) facade: generated typed wrappers over the GDScript scenes and controllers, typed signals, options records, `PKeyBrand.generated.cs`, NuGet/addon folder, C# demo twin

| Field       | Value                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Phase       | UK: UI kits: one design system for every SDK (docs/design/UI-KITS.md) (should)                 |
| Size        | 2–3 engineer-weeks                                                                             |
| Depends on  | [UK-11](UK-11-godot-kit.md)                                                                    |
| Unblocks    | none                                                                                           |
| Role        | `pkey-godot-engineer`                                                                          |
| Plan mode   | no                                                                                             |
| Gates       | the C# wrapper generator's drift check; the C# demo's screenshots match the GDScript baselines |
| Human input | none                                                                                           |
| Repo        | `vladzaharia/polaris-key`                                                                      |

## Goal

A Godot C# project uses the same kit with typed C# APIs, with no second implementation of any scene.

## Why

Godot .NET is a should row of §5.1. It is a facade over the GDScript kit and does not depend on X-01 (the full C# SDK), which stays optional (owner, 2026-10-05). The spec is [`docs/design/UI-KITS.md`](../../../../design/UI-KITS.md); its "Owner decisions (2026-10-05)" header wins over the sections below it.

## Read first

- `AGENTS.md` (always) and `CLAUDE.md`.
- [UI-KITS.md](../../../../design/UI-KITS.md) §5.1 Godot rows
- The UK-11 kit; X-01 brief (what stays out)

## Scope

**In:**

- Generated typed C# wrappers over the scenes and controllers, typed signals, options records.
- `PKeyBrand.generated.cs` (UK-01 target) wired in.
- Optional addon folder and NuGet package; C# twin of the demo project.

**Out** (and where it belongs instead):

- A C# SDK core (→ X-01, optional).

## Design notes

- None beyond the spec.

## Steps

1. Build the scope in the order listed.
2. Run the gates in the header.

## Acceptance criteria

- [ ] The C# demo renders the same baselines as the GDScript demo in both themes.
- [ ] The wrapper generator has a `--check` mode in the Godot lane.
- [ ] The green gate passes (AGENTS.md).

## Verify

```sh
sdks/godot/tools/run_tests.sh
```

## Hand-off

None.

The role agent sets `--set UK-29 in-review` when it hands off. After review, the lead adds the last
commit of the PR: `node docs/research/2026-09-29-godot-omniplatform/program/check.mjs --set UK-29 done`.
