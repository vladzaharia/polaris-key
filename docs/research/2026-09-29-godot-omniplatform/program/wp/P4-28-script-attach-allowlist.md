# P4-28 Script attachment allow-list and publish script-kind settings

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Phase       | P4: Packs                                                          |
| Size        | 0.5–1 engineer-weeks                                               |
| Depends on  | [P4-08](P4-08-godot-packs.md)                                      |
| Unblocks    | none                                                               |
| Role        | `pkey-godot-engineer`                                              |
| Plan mode   | no (if it adds a manifest field, that is rule 9: say so in the PR) |
| Gates       | all SDKs; cli bundle; threat model                                 |
| Human input | none                                                               |
| Repo        | `vladzaharia/polaris-key`                                          |

## Goal

Close the residual P4-08's audit left open: a data pack may reference any script the app already
ships (text `ext_resource`, binary ext entries, `uid://`) and set its exported properties, so it can
instantiate debug/tool scripts or trigger `_init`/`_ready` side effects. Let an app declare which
scripts packs may attach, and let CI know about extra script languages.

## Scope

**In:**

- An app-declared allow-list of attachable script paths/UIDs (Godot SDK setting), checked on the
  device by the directory check before commit; the default when unset is decided in the PR and
  recorded in the threat model (prefer refusing all script references unless listed).
- The CLI lint's `scriptExtensions` / `scriptTypes` exposed as a `pkey release publish` setting (and
  the Action input), so an app with a GDExtension script language gets CI refusals matching the
  device's engine-derived kinds.
- Shared fixtures for both; THREAT-MODEL residual updated.

## Acceptance

- [ ] A pack attaching an unlisted app script is refused on the device; a listed one is admitted.
- [ ] A custom script extension configured for publish is refused by the CLI lint.
- [ ] The full green gate passes.
