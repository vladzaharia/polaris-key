-- F-hardening: a package version's deprecation survives a yank. `state` has one slot, and a yank
-- overrides a deprecation, so the deprecation text moves here while the version is yanked and
-- an unyank restores `deprecated` instead of dropping it (plans/F-01.md §6.3).
ALTER TABLE release_packages ADD COLUMN deprecation_message TEXT;
