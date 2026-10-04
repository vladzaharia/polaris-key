-- P6-02 — the product's device-trust policy, OPERATOR-owned: which operations require an
-- `attested` device (`mint`, `gatedDelivery`, `commerceClaim`), whether a refusal is enforced or
-- only audited (`enforce`, false by default), and the App Attest / Play Integrity settings the
-- verifier needs (Team ID, aaguid environment, cloud project number). No manifest ingest or
-- resync writes it. NULL = the default policy (everything `basic`, log-only, nothing configured).
-- One bare ALTER and nothing after it (0018_index_assertion.sql).
ALTER TABLE products ADD COLUMN trust_policy_json TEXT;
