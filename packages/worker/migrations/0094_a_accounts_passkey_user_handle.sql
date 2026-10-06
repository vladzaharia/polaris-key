-- I-16 (S-16 §5.4 item 7, "Passkeys"): the account's WebAuthn user handle. One random value per
-- account (32 bytes, base64url), minted the first time the person asks to add a passkey and then
-- reused for every passkey they add, so an authenticator keeps ONE "Polaris Key" entry for the
-- account. It is never the account id and is derived from nothing: a credential's user handle
-- says nothing about who the person is. NULL: the account has never started a passkey enrolment.
-- Each `account_passkeys` row keeps the handle it was created under (a merge moves rows, not
-- handles), and a passkey sign-in checks the assertion's handle against its own row's.
--
-- Identity owns the table. ONE statement per file (R11-04).
ALTER TABLE accounts ADD COLUMN passkey_user_handle TEXT;
