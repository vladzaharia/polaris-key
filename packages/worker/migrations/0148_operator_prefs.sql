-- LK-FU-2: per-operator console preferences that follow the operator across browsers. Today one:
-- whether Home's Platform ready guide is hidden (it was localStorage, per browser).
--
--   operator_sub        the console session's `sub` (the operator's account id), never an email.
--   setup_guide_hidden  1 once the operator hid the guide, 0 after they restored it.
--   updated_at          epoch seconds of the last change.
--
-- Core-owned; written only by core/accounts/operatorPrefs.ts. Expand-only: a Worker built before
-- this migration never names the table. Rollback: scripts/rollback/0148_operator_prefs.down.sql.
CREATE TABLE IF NOT EXISTS operator_prefs (
  operator_sub       TEXT PRIMARY KEY,
  setup_guide_hidden INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);
