/**
 * Core's own data-migration jobs (P0-49). U-27 removed the licence-override migration (U-03) and
 * registers its replacement: the provisioned-secret backfill (U-27.6), dropped with its ledger in
 * U-27b. A Core job that Core must not let the runner start is still expressible with
 * `MigrationJob.delegatedTo`; the runner keeps that refusal.
 */

import type { MigrationJob } from "./job.js";
import { provisionedSecretsToAccountJob } from "./provisionedSecretsJob.js";

export const CORE_MIGRATIONS: readonly MigrationJob[] = [
  provisionedSecretsToAccountJob,
];
