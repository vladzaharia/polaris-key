/**
 * Core's own data-migration jobs (P0-49). None is registered: the licence-override migration (U-03)
 * was the only one, and U-27 removed it. A Core job that Core must not let the runner start is
 * still expressible with `MigrationJob.delegatedTo`; the runner keeps that refusal.
 */

import type { MigrationJob } from "./job.js";

export const CORE_MIGRATIONS: readonly MigrationJob[] = [];
