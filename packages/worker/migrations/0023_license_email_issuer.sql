-- 0023 — record, on the LICENCE row, which issuer class produced its email (B2-01).
--
-- `syncAccountLicenseLinks` decided whether a licence may auto-link into a portal account at
-- READ time, from the product's CURRENT `oidc_config.provider`. Nothing on the row said which
-- issuer had actually vouched for the address, so the containment was reversible by editing the
-- product: a tenant mints licences for a victim's address under its own custom issuer (where
-- `email_verified: true` is the tenant's to assert), then pushes a `.pkey/product` that lowers
-- `oidc.provider` from `custom` to `platform`, and every one of those rows becomes auto-linkable
-- retroactively — permanently, and with no self-service way for the victim to remove them.
--
-- The column is written at MINT time by `activateFromIdentity` from the provider that was
-- actually resolved for that sign-in, so a later manifest push cannot re-decide it.
--
-- NULL is deliberately meaningful: "no writer recorded an issuer for this address". Only the
-- OIDC lane knows one; an admin-created or enrolled licence leaves it NULL and
-- `syncAccountLicenseLinks` then falls back to the product's live provider, which is exactly the
-- pre-B2-01 rule. The backfill therefore stamps existing rows with the class their product
-- resolves to TODAY: byte-for-byte the answer the read-time expression was already giving them,
-- so deploying this changes no existing licence's link behaviour. It is scoped to `origin =
-- 'oidc'` for the same reason the writer is: those are the rows whose email came from an
-- issuer at all.
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
