-- P6-02 — the last attestation's verdict summary (kind, outcome, environment, licensing verdict,
-- the App Attest public key kept for later assertions). Never a raw attestation object or
-- integrity token. NULL while the device never attested.
-- One bare ALTER and nothing after it (0018_index_assertion.sql).
ALTER TABLE devices ADD COLUMN attestation_json TEXT;
