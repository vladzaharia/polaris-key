---
title: "The license-override migration is gone"
date: "2026-10-22"
version: "0.9.0"
type: "removed"
services: ["license", "config"]
sdks: []
replaces:
  - old: "The seven `/manage/api/platform/override-migration` routes (read, prerequisites, notice, dry-run, run, report)"
    new: "Nothing: there is no run to read."
    surface: "console"
  - old: "`pnpm --filter @polaris-key/worker override-migration:dry-run`"
    new: "Nothing."
    surface: "console"
  - old: "The job `core.licence-override-migration`"
    new: "`core.provisioned-secrets-to-account` moves provisioned secrets to the owner's account row (see the migration ledger)."
    surface: "console"
  - old: "`configOverrides.phase` and `runNotBefore` in the license detail, `licenseLayerRetired` in the account overrides answer, `migrationReport` in the Users data answer"
    new: "Read the license's overrides; an owned license shows `owned`, `ownerSubject` and `signUpUrl`."
    surface: "console"
---

**Action required:** none for a manifest. Stop calling the removed routes and stop running the script.

A license's own config and secret overrides stay: they are layer 4 of the merge, and the license overrides route accepts config, secret and flag keys on every license, floating or owned.

Provisioned secrets now live on the owner's account row when the signing identity is linked to the license's owner. The tables `override_migration` and `override_migration_report` are neither read nor written; a later release drops them.
