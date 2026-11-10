// Imported for its side effect by every vitest config: the test run's clock zone and locale are
// fixed (CI runs UTC / en-US; a laptop does not), so a date or number that a test compares to a
// literal formats the same everywhere. Vitest's workers and the browsers a test launches inherit
// this process's environment, so setting it here, before they start, covers them too.
// tools/brittle-guard.test.ts fails a config that does not import this file.
process.env.TZ = "UTC";
process.env.LC_ALL = "en_US.UTF-8";
process.env.LANG = "en_US.UTF-8";
delete process.env.LANGUAGE;
