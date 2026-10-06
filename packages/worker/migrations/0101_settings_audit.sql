-- ST-04 (notes/S-18 §4.6): the structured settings audit. `writeSetting()`
-- (`src/core/settings/write.ts`) is the one write path for registry-backed settings, and every
-- write it makes appends one audit row in the same batch as the change, now carrying:
--
--   before_json  the side before, as `{"stored": …, "version": …, "effective": …, "source": …}`
--                (A-13's platform-audit shape; a secret's `stored`/`effective` are `{"set": bool}`,
--                presence only). The resync's per-field rows write `{"effective": …}` alone.
--   after_json   the side after, the same shape
--   origin       who caused it: console | api | resync | manifest-push | revert | restore |
--                system | ci (the vocabulary lives in `core/settings/types.ts` `SETTING_ORIGINS`;
--                no CHECK, so a later origin needs no rebuild of this append-only table)
--   reason       the operator's reason (required for `critical` keys on the generic API)
--   setting_key  the registry key (`core.name`, `license.defaults.deviceLimit`), indexed so a
--                setting's history and ST-24's "latest row per setting survives the prune" are one
--                index range each
--
-- `platform_audit` already has before_json/after_json (0054_b); it gains the other three.
--
-- Both tables stay Core's (`TABLE_OWNERS.core`). Expand-only: four nullable columns and two
-- partial indexes. A Worker deployed before this migration never names them and every existing
-- INSERT lists its columns, so it keeps working; rows it writes read back with NULLs.
--
-- Rollback: a pre-ST-04 Worker ignores the columns, so no SQL is needed. To remove them anyway:
--   DROP INDEX idx_audit_setting;
--   DROP INDEX idx_platform_audit_setting;
--   ALTER TABLE audit DROP COLUMN before_json;   (and after_json, origin, reason, setting_key)
--   ALTER TABLE platform_audit DROP COLUMN origin; (and reason, setting_key)

ALTER TABLE audit ADD COLUMN before_json TEXT;
ALTER TABLE audit ADD COLUMN after_json TEXT;
ALTER TABLE audit ADD COLUMN origin TEXT;
ALTER TABLE audit ADD COLUMN reason TEXT;
ALTER TABLE audit ADD COLUMN setting_key TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_setting
  ON audit(product, setting_key, at DESC)
  WHERE setting_key IS NOT NULL;

ALTER TABLE platform_audit ADD COLUMN origin TEXT;
ALTER TABLE platform_audit ADD COLUMN reason TEXT;
ALTER TABLE platform_audit ADD COLUMN setting_key TEXT;

CREATE INDEX IF NOT EXISTS idx_platform_audit_setting
  ON platform_audit(setting_key, at DESC)
  WHERE setting_key IS NOT NULL;
