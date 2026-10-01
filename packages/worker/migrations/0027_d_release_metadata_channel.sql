-- P2-03 — the channel a release was published to (`pkey release publish --channel`, README §6.1).
--
-- NULL means "derive from GitHub": stable unless prerelease, plus the manual-channel regexes, as
-- today. Nothing written by the GitHub sync sets it, and a resync never clears it.
--
-- ONE statement per file (see 0013/0020).
ALTER TABLE release_metadata ADD COLUMN channel TEXT;
