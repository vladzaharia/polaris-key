-- Rollback of 0123_notify_destinations.sql. Operator alerts go back to audit only; nothing else
-- reads the tables. The sealed webhook secrets go with the destinations they signed for.
DROP TABLE IF EXISTS notify_destination_secrets;
DROP INDEX IF EXISTS idx_notify_destinations_product;
DROP TABLE IF EXISTS notify_destinations;
