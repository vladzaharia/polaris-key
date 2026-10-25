// Replace with the file `pkey sdk --lang node --write` generates for your product.
export default {
  productSlug: "tidewater",
  trust: {
    pinnedKeys: {
      "pkey-tidewater-prod-2026-06":
        "REPLACE_WITH_TIDEWATER_ED25519_PUBLIC_KEY_BASE64URL",
    },
  },
  update: {
    pinnedReleaseKeys: {
      "pkey-tidewater-release-2026-06":
        "REPLACE_WITH_TIDEWATER_RELEASE_KEY_BASE64URL",
    },
  },
};
