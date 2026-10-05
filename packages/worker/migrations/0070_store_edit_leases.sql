-- A-18e (notes/S-15 §5.3, threat-model control (e)): the per-app EDIT LEASE. Google Play's only
-- write path is an edit, a service account may hold one open edit, and any new edit, commit or
-- Console change invalidates every other open one. P5-03's poller opens and discards an edit on
-- every tick, its controls and A-16's `?tracks=1` lister do the same, and a provisioning run that
-- uploads twenty images inside one edit would be invalidated by the next tick. So every Play
-- caller first takes this lease on the package, and a caller that finds it held does not open an
-- edit at all (a poll skips its tick; a control or a lister lookup answers "busy").
--
-- Distribution's (`TABLE_OWNERS.distribution` in the docs generator): written and read only by
-- `src/services/distribution/connectors/play/lease.ts`. Global by design (R11-05): an app id
-- belongs to the store account, not to a product (the platform service account serves every
-- product pinned to it, and A-16's lister is team-wide), so the key is (store, app).
--
--   store        the storefront adapter id ('google-play')
--   app          the store's app id: Play's package name
--   holder       a random id the acquirer keeps; only it may renew or release the lease
--   purpose      provisioning | import | poll | control | lister (who holds it, for the answer a
--                refused caller gets; never a credential or a person)
--   actor        'admin:<sub>', 'connector:play' or 'connector:play-vitals'
--   acquired_at  epoch seconds
--   expires_at   epoch seconds; an expired row is free, so a crashed holder blocks nobody for
--                longer than its TTL. A long upload renews it.
--
-- Acquisition is ONE statement (an upsert whose update applies only over an expired row), so two
-- callers racing for a free lease cannot both win. Release deletes only the holder's own row.
CREATE TABLE IF NOT EXISTS store_edit_leases (
  store        TEXT NOT NULL,
  app          TEXT NOT NULL,
  holder       TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('provisioning', 'import', 'poll', 'control', 'lister')),
  actor        TEXT NOT NULL,
  acquired_at  INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (store, app)
);
