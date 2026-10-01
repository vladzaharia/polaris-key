---
"@polaris-key/client-core": minor
---

Add the boot stage machine, `@polaris-key/client-core/stages`: `initialBootState`, the pure
reducer `bootTransition(state, event) → { state, emits }`, the boot guard's launch decision
`bootGuardAction({ staged, failedBoots })` with `MAX_FAILED_BOOTS = 2`, and the five
vocabulary lists (`BOOT_STAGES`, `BOOT_OUTCOMES`, `BOOT_EVENT_TYPES`, `BOOT_EMIT_TYPES`,
`BOOT_GUARD_ACTIONS`). Every renderer drives the same machine, and
`conformance/corpus/v2/stage-matrix.json` pins it in every language. Nothing on the wire
changes, and the new API does nothing until a host calls it.
