// The Action bundle's stand-in for `@napi-rs/keyring` (bundle-action.mjs aliases the import here).
// The Action has no credential store, so loading it fails and the account commands refuse.
throw new Error("pkey-action-no-keyring");
