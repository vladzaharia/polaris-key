-- PX-W16 (PORTAL.md §4.30, G33): account pictures, re-encoded and content-addressed.
--
-- One row per stored picture ("asset"): the four renditions (WebP and PNG at 256 and 96 px) live
-- in the BLOBS bucket under `avatars/<asset>/<size>.<format>` and are served at
-- `/media/avatar/<asset>`. `asset` is a peppered HMAC of the account and the source picture's
-- SHA-256, so the same picture is stored once per account and the id names nobody.
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
-- The two expression and partial indexes below serve the "does anything use this asset?" reads
-- of the sweep, deletion and replacement, so none of them scans `account_links`.
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
CREATE INDEX IF NOT EXISTS idx_accounts_avatar_key
  ON accounts(avatar_key) WHERE avatar_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_links_avatar
  ON account_links(json_extract(profile_json, '$.avatarKey'));
