-- Wire contract §2.3: a revoked signing key SHOULD stay in the trust manifest with
-- status "revoked" for at least 2× cacheSeconds after revocation, so every client that
-- could still hold the key cached gets a POSITIVE removal signal instead of inferring it
-- from absence. `status`/`rotated_at` cannot express "when was it revoked" — rotation also
-- stamps `rotated_at` — so the window needs its own column. NULL for every key revoked
-- before this migration: those are long past any client's cache window.
ALTER TABLE product_keys ADD COLUMN revoked_at INTEGER;
