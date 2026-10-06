// Replace with the file `pkey sdk --lang node --write` generates for your product.
export default {
  productSlug: "djdl",
  trust: {
    pinnedKeys: {
      "pkey-djdl-prod-2026-06":
        "REPLACE_WITH_DJDL_ED25519_PUBLIC_KEY_BASE64URL",
    },
  },
  update: {
    pinnedReleaseKeys: {
      "pkey-djdl-release-2026-06": "REPLACE_WITH_DJDL_RELEASE_KEY_BASE64URL",
    },
  },
};
