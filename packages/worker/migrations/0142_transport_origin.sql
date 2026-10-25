-- P4-33.2: how a transport route was chosen. `declared` (the manifest names it, the default for
-- every existing row), `auto` (`transports.packs: auto` resolved it) or `default` (the product's
-- default). Readiness serves an `auto` Background Assets route from the CDN until the asset
-- packs are uploaded; a declared route still fails closed. Rewritten by every link and resync.
ALTER TABLE dist_transports ADD COLUMN origin TEXT NOT NULL DEFAULT 'declared';
