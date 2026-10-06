// Every test process gets a throwaway home: the SDK persists state (the update-health journal,
// the boot guard's slots, local config overrides) under the platform's default directories when a
// test names none, and a test run must never write into the developer's real home.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pkey-node-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.XDG_CACHE_HOME;
