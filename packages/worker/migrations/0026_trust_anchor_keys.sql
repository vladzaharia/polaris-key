-- B3-01 — split the TRUST ANCHOR from the document signing keys.
--
-- THE DEFECT. The trust manifest was signed by whatever key was `status='active'`, while
-- `client-core`'s `verifyTrustManifest` verifies a manifest against PINNED keys only — the
-- property that closed the prior audit's R2-01 ("a manifest must never be verifiable by a key
-- the manifest itself introduced"). Both rules are right. Composed, they meant that the moment
-- the active key rotated away from a pinned key, every already-installed client rejected every
-- later manifest: trust refresh stopped, the monotonic clock floor stopped advancing, and
-- revocation stopped — for exactly the install base you need to reach after a key compromise.
-- Rotation was not an operation; it was an application release.
--
-- THE SHAPE. `role` splits the key set by PURPOSE. An `anchor` signs `pkey-trust+jws` and
-- nothing else and is what a host application pins; a `document` key signs license, config and
-- bundle documents and rotates freely underneath the anchor. Wire contract v3 §1.1 / §2.3.
--
-- WHAT THIS MIGRATION DOES ABOUT EXISTING PRODUCTS. It promotes each product's current ACTIVE
-- key to be its anchor. That is the only choice that keeps every deployed client working across
-- the deploy: those clients pin exactly that key, so the manifest signer does not move under
-- them. It is deliberately NOT a fresh anchor — minting one needs Ed25519 keygen and an AES-GCM
-- seal under the platform KEK, neither of which SQLite can do, and a migration that left a
-- product with an anchor nobody had pinned would break every install on deploy, which is the
-- very failure being fixed.
--
-- The consequence, stated rather than hidden: immediately after this migration a legacy product
-- has an anchor and NO separate document key, so `loadProduct` keeps using the anchor to sign
-- documents too (`core/products.ts` — the documented transitional fallback). That is exactly
-- today's behaviour, so nothing regresses. The split becomes real on the first document-key
-- rotation, which is a routine operation from that moment on. Products created after this
-- migration get two distinct keys at create time and never see the fallback.
--
-- REPLAY. The `ALTER` is first because every statement after it references the column it adds,
-- so the R11-04 "idempotent statements first" ordering is not available here; a replay dies on
-- `duplicate column name` exactly like the other ALTER-bearing migrations, having changed
-- nothing. Everything after it is `IF NOT EXISTS` or an idempotent DELETE+INSERT.

ALTER TABLE product_keys ADD COLUMN role TEXT NOT NULL DEFAULT 'document'
  CHECK (role IN ('anchor', 'document'));

-- Promote the current active key of every product to be that product's anchor. `status='active'`
-- is at-most-one per product before this migration (`idx_product_keys_one_active`), so this
-- touches exactly one row per product, and a product with no active key has no `Product` at all
-- and therefore nothing to anchor.
UPDATE product_keys SET role = 'anchor' WHERE status = 'active';

-- One active key per product PER ROLE. The old index was `UNIQUE(product) WHERE status='active'`,
-- which a product holding both an active anchor and an active document key violates by
-- construction — so it is redefined rather than merely supplemented. The NAME is kept: it is
-- asserted at deploy time by `schema_index_assertion` and on every cron tick by
-- `assertRequiredIndexes()`, and renaming it would silently drop an invariant from both lists.
-- DROP INDEX is not a table or column drop; the additive-only migration rule (R11-08) is about
-- shapes old code reads, and no code reads an index by name except those two assertions.
DROP INDEX IF EXISTS idx_product_keys_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_keys_one_active
  ON product_keys(product)
  WHERE status = 'active' AND role = 'document';

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_keys_one_active_anchor
  ON product_keys(product)
  WHERE status = 'active' AND role = 'anchor';

-- Re-assert the required-index set with the anchor index added (0018 explains the mechanism).
-- It lives here and not as an edit to 0018 because D1 records 0018 as applied and will never
-- re-run it: an edit there would assert the new index on fresh databases only, i.e. everywhere
-- except production. `test/scheduled.test.ts` reads the NEWEST assertion list and compares it to
-- `REQUIRED_INDEXES`, so the two still cannot drift.
DELETE FROM schema_index_assertion;

WITH required(name) AS (
  VALUES
    ('idx_audit_time'),
    ('idx_devices_license_status'),
    ('idx_devices_seat'),
    ('idx_licenses_email_lower'),
    ('idx_licenses_enroll_hwid'),
    ('idx_licenses_origin'),
    ('idx_licenses_sub'),
    ('idx_licenses_sub_global'),
    ('idx_portal_account_emails_account'),
    ('idx_portal_account_identities_account'),
    ('idx_portal_audit_at'),
    ('idx_portal_audit_product_at'),
    ('idx_portal_license_links_license'),
    ('idx_product_keys_one_active'),
    ('idx_product_keys_one_active_anchor'),
    ('idx_product_keys_verify'),
    ('idx_release_download_tokens_expiry'),
    ('idx_release_download_tokens_hash')
)
INSERT INTO schema_index_assertion (id, expected, found, missing)
SELECT
  1,
  (SELECT COUNT(*) FROM required),
  (SELECT COUNT(*) FROM required r
    WHERE EXISTS (SELECT 1 FROM sqlite_master m
                   WHERE m.type = 'index' AND m.name = r.name)),
  (SELECT COALESCE(group_concat(r.name, ', '), '')
     FROM required r
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m
                       WHERE m.type = 'index' AND m.name = r.name));
