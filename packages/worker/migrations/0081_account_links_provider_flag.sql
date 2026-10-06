-- I-06 (S-16 §5.2, "server-to-server notifications unlinking or flagging the link"): what a
-- provider has told us about a sign-in method since it was linked. Today only Sign in with Apple
-- sends such events: `consent_revoked` (the person stopped using Apple with Polaris Key; cleared
-- by their next Apple sign-in, which is a fresh consent), `account_deleted` (the Apple ID is gone
-- and the subject can never sign in again) and `email_disabled` (the private-relay address stopped
-- forwarding; cleared by `email-enabled`). NULL = nothing reported. The link is FLAGGED, never
-- deleted: removing a method stays the person's own step-up action, with its last-method guard.
--
-- ONE statement per file (R11-04).
ALTER TABLE account_links ADD COLUMN provider_flag TEXT;
