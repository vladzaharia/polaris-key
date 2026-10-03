-- P6-02 — a device's trust level: `basic` (every device, the default and the expected answer for
-- web, desktop and sideloaded builds) or `attested` (the device proved a genuine store install
-- with App Attest or Play Integrity against a fresh challenge, `POST /<p>/devices/attest`).
-- Written only by `core/deviceTrust.ts`; `upsertDevice` deliberately preserves it, and a keyless
-- re-registration or a licence (re)bind resets it to `basic` (a new token is not the attested
-- install). "trust level", not "tier": the glossary reserves tier for licence tiers.
-- One bare ALTER and nothing after it (0018_index_assertion.sql).
ALTER TABLE devices ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'basic';
