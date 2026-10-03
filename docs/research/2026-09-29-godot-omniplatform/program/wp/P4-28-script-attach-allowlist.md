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

## Corrections from implementation

- **The default is strict.** With no list, a pack attaches no app script and reaches no UID
  outside its own uid cache, on the device (`PKeyOptions.pack_attachable`) and in the publish
  lint (`deliverables.app.content.attachable`). A compatibility default would leave the
  residual open in every app that never configures it, and no shipped pack relies on attaching
  app scripts (Diceroll's planned packs are assets). Strict is made easy by naming every refused
  reference in the lint and accepting `res://…/` directories. Recorded in THREAT-MODEL "Pack
  bytes on the device".
- **The list holds UIDs, not only scripts.** The engine prefers a resolvable UID over the path,
  the CLI cannot know what an app UID names, and the device must give the CLI's verdict, so a
  UID outside the pack's own cache is refused whatever it names unless listed. A pack that
  reaches a non-script base-game resource by UID (the f_uid packs reach `uid://s05mainbase1`)
  lists that UID; a non-script app resource referenced by path needs nothing. Godot 4.4+ writes
  the path and the UID of a script reference, so both are listed; the field is therefore
  `attachable`, not `attachableScripts`.
- **A manifest field (rule 9).** `deliverables.app.content.attachable`: 1–256 distinct entries,
  `res://` paths already normal (the PCK path rules) or directories ending in `/`, or canonical
  `uid://` (`invalid_app_attachable`; schema pattern, mutation entries for both the schema-
  expressible and validator-only cases, docs, the authoring skill). It configures the lint only
  and is never stamped into a release, so there is no wire, corpus or protocol change.
- **The reference check reads the engine's formats rather than scanning for strings.** From the
  4.4.1 and 4.7.2 sources (`resource_format_text.cpp`, `resource_format_binary.cpp`,
  `variant_parser.cpp`): text tags must be one strict line each (the parser keeps the last of a
  repeated key, accepts comments and StringNames inside a tag), and `Resource("…")` loads any
  path or UID directly, so it is refused wherever it could parse. The binary loader still
  honours the pre-4.0 inline `OBJECT_EXTERNAL_RESOURCE` in property data and reuses any cached
  resource whose path a non-`local://` sub-resource names, so both validators walk the header,
  tables and every property (all 53 value types; an unknown one is refused) instead of
  searching bytes; relative paths resolve against the resource's own directory and are refused.
- **Synthetic binary fixtures had to become real.** `packFixtures.ts`'s `binaryResource` wrote a
  header and opaque bytes; the walk refuses those, so it now writes Godot's layout (format 6,
  tables, properties), the RSCC bodies too (`resHead`), and the kaykit fixtures and update
  objects were regenerated. Every pre-existing verdict is unchanged except `audit-binary-extref`
  (now refused: the residual it pinned is closed) and `ext-script-ok`, replaced by the `refs-*`
  fixtures (refused: unlisted text and binary script references, a UID to an app script, a
  script behind a remap, a reference to a `.remap` file, every ambiguous form; admitted: listed
  text, binary and directory references, listed UIDs, in-pack and non-script references, and
  kaykit with no script references). The real 4.7.2 and 4.4.1 imports walk cleanly.
- **Remaps.** A script behind a pack's own `.remap` is judged where it is: the exported file the
  remap names is a pack entry and gets the reference check (`refs-remap`). A reference naming a
  `.remap` or `.import` file is refused.
- **Real-engine probes.** `_attach_probes` saves a Resource with an app script attached as text,
  binary and RSCC on the running engine: refused with nothing listed, admitted listed, and, once
  mounted, the resource loads with the app script attached and the pack's value set (the
  residual, measured). Saved outside `res://` the engine wrote no UID into the reference. The
  f_uid exports are refused at their reference to `uid://s05mainbase1` without the list.
- **Script kinds at publish.** `pkey release publish --script-extensions/--script-types` and the
  Action's `script-extensions`/`script-types` inputs (godot.pck only; refused for a tree pack or
  the app, and for a malformed extension or type). They also count as script types in the
  reference check.
- **Out of scope.** `files.tree` resources get no reference check (a tree is never mounted into
  `res://`), and an app resource referenced by path runs whatever the app composed into it;
  both are recorded as residuals.
- **Audit follow-up (GAP A–C, UIDs).** (A) A sub-resource setting `resource_path` enters the
  resource cache under that path; measured on 4.7.2 and 4.4.1 (`_cache_probe`: the app's next
  `load()` of the path returns the pack's object). Both validators refuse a text resource naming
  `resource_path` anywhere (raw or behind escapes) and a binary property named so (string table
  or inline), one line (`refs-resource-path-text`, `refs-resource-path-binary`). (B) Internal
  offsets must follow the tables, strictly ascending, each walk ending by the next offset (the
  saver writes them in sequence; every real import passes), with the walked total capped at the
  stream length (`refs-overlap-offsets`). (C) Device only: an out-of-pack reference without a
  script extension is judged by the resource's real type, read from its file the way the loaders
  do (GDScript cannot call `ResourceLoader.get_resource_type`, and loading would run static
  initialisers): a `.remap` followed, an imported file's `.import` type, a binary or text head;
  unreadable but existing counts as a script. (UIDs) Device only: a UID outside the pack's cache
  that the app registers is judged by the path `ResourceUID` maps it to, so an app texture by UID
  passes and an app script needs listing; the CLI stays strict, so CI needs such UIDs listed (the
  device is the laxer side only for app-registered non-script UIDs, and the stricter side for
  scripts saved under resource extensions; documented in the threat model, ci.md and
  authoring.md). The f_uid exports are now admitted on the device without a list. The shared
  fixtures resolve nothing on the device, so their verdicts stay identical.
- **Audit follow-up (GAP D).** The device reads an app RSCC scene's type from its first block
  only (`PKeyPck.rscc_first_block`, sharing `rscc_body`'s header rules and frame walk through
  `_rscc_head`, `_rscc_block_size` and `_rscc_decode`; the total cap does not apply to app files)
  and memoises each path's type per directory check (`tree_check` runs no reference check, so it
  needs none). Device probe `_type_scale_probe`: a pack `.tres` with 2,000 `ext_resource` tags
  typed `Resource` naming one ~30 MB app scene, plus one naming a scene declaring 71,303,793
  bytes (over the 64 MiB pack cap), is admitted with both typed PackedScene: 25 ms in the 4.7.2 editor, 21 ms on the 4.7.2 release template and 24 ms on 4.4.1 (bound `TYPE_SCALE_BOUND_MS` = 3,000). Both validators also refuse a binary property
  name that is not valid UTF-8 (`refs-name-utf8`).
