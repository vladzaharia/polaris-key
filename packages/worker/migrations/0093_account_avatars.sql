-- PX-W16 (PORTAL.md §4.30, G33): account pictures, re-encoded and content-addressed.
--
-- One row per stored picture ("asset"): the four renditions (WebP and PNG at 256 and 96 px) live
-- in the BLOBS bucket under `avatars/<asset>/<size>.<format>` and are served at
-- `/media/avatar/<asset>`. `asset` is an HMAC under KEY_HASH_PEPPER of the account and the source
-- picture's SHA-256 (a plain SHA-256 of the same string on a deployment without the pepper), so
-- the same picture is stored once per account and the id names nobody.
--
--   account_id   whose picture it is. Not a foreign key: account deletion deletes the objects
--                first and these rows after (`deleteAccountAvatars`), and a merge moves them to
--                the survivor with the links that use them.
--   origin       `provider` (a sign-in method's picture, fetched from an allowlisted host) or
--                `upload` (Account → Profile).
--   bytes        the four renditions' total size, for storage accounting.
--   created_at   when it was last stored. An asset nothing uses (`accounts.avatar_key`, a link's
--                `profile_json.avatarKey`) and older than a day is deleted by the nightly sweep.
--
-- "Does anything still use this asset?" reads only its owner's rows (the accounts primary key and
-- `idx_account_links_account`): an asset belongs to one account, and a merge moves these rows with
-- the links. So this file touches no existing table and applies in any order.
--
-- Identity owns the table (TABLE_OWNERS). Expand-only: nothing older reads it, and every
-- statement is IF NOT EXISTS, so a replay converges.
CREATE TABLE IF NOT EXISTS account_avatars (
  asset       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  origin      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  CHECK (origin IN ('provider', 'upload'))
);
CREATE INDEX IF NOT EXISTS idx_account_avatars_account
  ON account_avatars(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_account_avatars_created
  ON account_avatars(created_at);
