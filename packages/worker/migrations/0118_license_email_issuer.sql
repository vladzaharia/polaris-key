-- Record, on the LICENCE row, which issuer class produced its email.
--
-- The portal's auto-link rules (`services/identity/portal/repo.ts`: `attachWaitingLicensesByEmail`,
-- `syncAccountLicenseLinks`, and the licence-holder hook) decided whether a licence may join a
-- portal account at READ time, from the product's CURRENT `oidc_config.provider`. Nothing on the
-- row said which issuer had actually vouched for the address, so the containment was reversible
-- by editing the product: a tenant mints licences for a victim's address under its own `custom`
-- issuer (where `email_verified: true` is the tenant's to assert), then pushes a `.pkey/product`
-- that lowers `oidc.provider` from `custom` to `platform`, and every one of those rows becomes
-- auto-linkable retroactively: permanently, and with no self-service way for the victim to remove
-- them.
--
-- The column is written at MINT time by `activateFromIdentity` (`services/identity/oidc.ts`), from
-- the provider that was actually resolved for that sign-in, and again whenever a sign-in rewrites
-- the row's `email`, so a later manifest push cannot re-decide it. `core/repo.ts` carries it as
-- `LicenseRow.email_issuer_class`. It never reaches a developer-facing response.
--
-- NULL is deliberately meaningful: "no writer recorded an issuer for this address". Only the OIDC
-- lane knows one; an admin-created, batch-created or enrolled licence leaves it NULL, and the
-- auto-link rules then fall back to the product's live provider, which is exactly the rule that
-- existed before this column. The backfill below stamps the existing OIDC rows with the class
-- their product resolves to TODAY: byte-for-byte the answer the read-time expression was already
-- giving them, so deploying this changes no existing licence's link behaviour. It is scoped to
-- `origin = 'oidc'` for the same reason the writer is: those are the rows whose email came from
-- an issuer at all. A product with no `oidc_config` row resolves to NULL, i.e. the live fallback.
--
-- Expand-only: a Worker deployed before this migration never names the column, and every INSERT
-- it makes lists its columns, so it keeps working; the rows it writes read back with NULL. The
-- ALTER comes first, so a replay dies there on `duplicate column name` before it reaches the
-- UPDATE. Rollback: nothing to run; to remove the column anyway,
--   ALTER TABLE licenses DROP COLUMN email_issuer_class;
-- Exercised by test/licenseEmailIssuerMigration.test.ts.
ALTER TABLE licenses ADD COLUMN email_issuer_class TEXT;

UPDATE licenses
   SET email_issuer_class = (
     SELECT CASE
              WHEN COALESCE(o.provider, 'platform') = 'custom' THEN 'custom'
              ELSE 'platform'
            END
       FROM oidc_config o
      WHERE o.product = licenses.product
   )
 WHERE origin = 'oidc';
