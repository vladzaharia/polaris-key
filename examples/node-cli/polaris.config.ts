// Replace with the file `pkey sdk --lang node --write` generates for your product: the slug and
// the pinned trust keys (kid → raw Ed25519 public key, base64url). Never paste keys by hand.
export default {
  productSlug: "djdl",
  trust: {
    pinnedKeys: {
      "pkey-djdl-prod-2026-06":
        "REPLACE_WITH_DJDL_ED25519_PUBLIC_KEY_BASE64URL",
    },
  },
};
