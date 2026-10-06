-- LX-28 (notes/S-24 §6.1): a batch's licences, for its used count, Disable unused keys and the
-- licence list's `?batch=` filter. Partial: only batch licences are indexed. A read aid, not an
-- invariant, so it is not in the deploy-time index assertion.
CREATE INDEX IF NOT EXISTS idx_licenses_batch
  ON licenses(product, batch_id) WHERE batch_id IS NOT NULL;
